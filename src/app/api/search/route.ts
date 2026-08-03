/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites, getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { getProxyToken } from '@/lib/emby-token';
import { hasFeaturePermission } from '@/lib/permissions';
import {
  executeSavedSourceScript,
  listEnabledSourceScripts,
  normalizeScriptSearchResults,
  normalizeScriptSources,
} from '@/lib/source-script';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  const username = authInfo?.username || 'admin';

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const includeSpecialSources = searchParams.get('special') === '1';

  if (!query) {
    const cacheTime = await getCacheTime();
    return NextResponse.json(
      { results: [] },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Netlify-Vary': 'query',
        },
      }
    );
  }

  const config = await getConfig();

  // 1. 强制保证获取到 API 资源站列表（若无用户权限数据，直接从全局 Config 读取）
  let apiSites = await getAvailableApiSites(username, includeSpecialSources).catch(() => []);
  if (!apiSites || apiSites.length === 0) {
    console.warn('[Search] getAvailableApiSites 为空，强行提取全局配置源');
    apiSites = (config.SourceConfig || []).filter((s: any) => !s.disabled);
  }

  console.log(`[Search] 参与搜索的 API 站点数量: ${apiSites.length}`);

  // 权重映射表
  const weightMap = new Map<string, number>();
  (config.SourceConfig || []).forEach((source: any) => {
    weightMap.set(source.key, source.weight ?? 0);
  });

  // 2. 搜索所有 API 源
  const searchPromises = apiSites.map((site: any) =>
    Promise.race([
      searchFromApi(site, query),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${site.name || site.key} 超时(15s)`)), 15000)
      ),
    ]).catch((err) => {
      console.error(`[Search] 站点搜索失败 [${site.name || site.key}]:`, err.message);
      return [];
    })
  );

  // 3. 搜索脚本源
  let scriptPromises: Promise<any[]>[] = [];
  try {
    const scriptSummaries = await listEnabledSourceScripts();
    scriptPromises = scriptSummaries.map((script) =>
      Promise.race([
        (async () => {
          try {
            const sourcesExecution = await executeSavedSourceScript({
              key: script.key,
              hook: 'getSources',
              payload: {},
            });
            const sources = normalizeScriptSources(sourcesExecution.result);

            const searchResults = await Promise.all(
              sources.map(async (source) => {
                const execution = await executeSavedSourceScript({
                  key: script.key,
                  hook: 'search',
                  payload: {
                    keyword: query,
                    page: 1,
                    sourceId: source.id,
                  },
                });

                return normalizeScriptSearchResults({
                  scriptKey: script.key,
                  scriptName: script.name,
                  sourceId: source.id,
                  sourceName: source.name,
                  result: execution.result,
                });
              })
            );

            return searchResults.flat();
          } catch (error) {
            console.error(`[Search] 脚本搜索失败 [${script.name}]:`, error);
            return [];
          }
        })(),
        new Promise<any[]>((_, reject) =>
          setTimeout(() => reject(new Error(`${script.name} 超时`)), 15000)
        ),
      ]).catch(() => [])
    );
  } catch (e) {
    console.warn('[Search] 加载脚本源失败', e);
  }

  try {
    const allResults = await Promise.all([
      ...searchPromises,
      ...scriptPromises,
    ]);

    const apiResultsFlat = allResults.filter(Array.isArray).flat();
    let flattenedResults = [...apiResultsFlat];

    flattenedResults = flattenedResults.map((result) => ({
      ...result,
      weight: result.weight ?? (weightMap.get(result.source) ?? 0),
    }));

    if (!config.SiteConfig?.DisableYellowFilter) {
      flattenedResults = flattenedResults.filter((result) => {
        const typeName = result.type_name || '';
        return !yellowWords.some((word: string) => typeName.includes(word));
      });
    }

    // 排序
    flattenedResults.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

    // 宽松二次过滤：只有当抓到了数据时才过滤
    if (flattenedResults.length > 0 && query && query.trim() !== '') {
      const cleanKeywords = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

      const matchedResults = flattenedResults.filter((item) => {
        if (!item) return false;
        const itemTitle = String(item.title || item.vod_name || item.name || '').toLowerCase();
        if (!itemTitle) return false;

        return cleanKeywords.every((kw) => itemTitle.includes(kw));
      });

      // 如果二次过滤把所有数据都删光了，说明抓到的都是脏数据（返回的首页推荐）
      flattenedResults = matchedResults;
    }

    const cacheTime = await getCacheTime();

    return NextResponse.json(
      { 
        results: flattenedResults,
        debug: {
          siteCount: apiSites.length,
          query: query
        }
      },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Netlify-Vary': 'query',
        },
      }
    );
  } catch (error: any) {
    console.error('[Search] 搜索处理崩溃:', error);
    return NextResponse.json({ error: error.message || '搜索失败' }, { status: 500 });
  }
}
