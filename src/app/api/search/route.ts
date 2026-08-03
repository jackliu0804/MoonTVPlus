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
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
  const apiSites = await getAvailableApiSites(authInfo.username, includeSpecialSources);
  const [canAccessOpenList, canAccessEmby] = await Promise.all([
    hasFeaturePermission(authInfo.username, 'private_library'),
    hasFeaturePermission(authInfo.username, 'emby'),
  ]);

  // 创建权重映射表
  const weightMap = new Map<string, number>();
  config.SourceConfig.forEach(source => {
    weightMap.set(source.key, source.weight ?? 0);
  });

  // 检查是否配置了 OpenList
  const hasOpenList = !!(
    canAccessOpenList &&
    config.OpenListConfig?.Enabled &&
    config.OpenListConfig?.URL &&
    config.OpenListConfig?.Username &&
    config.OpenListConfig?.Password
  );

  // 获取所有启用的 Emby 源
  const { embyManager } = await import('@/lib/emby-manager');
  const embySourcesMap = await embyManager.getAllClients();
  const embySources = canAccessEmby ? Array.from(embySourcesMap.values()) : [];

  // 获取代理 token（用于图片代理）
  const proxyToken = await getProxyToken(request);

  // 为每个 Emby 源创建搜索 Promise
  const embyPromises = embySources.map(({ client, config: embyConfig }) =>
    Promise.race([
      (async () => {
        try {
          const searchResult = await client.getItems({
            searchTerm: query,
            IncludeItemTypes: 'Movie,Series',
            Recursive: true,
            Fields: 'Overview,ProductionYear',
            Limit: 50,
          });

          const sourceValue = embySources.length === 1 ? 'emby' : `emby_${embyConfig.key}`;
          const sourceName = embySources.length === 1 ? 'Emby' : embyConfig.name;

          return searchResult.Items.map((item) => ({
            id: item.Id,
            source: sourceValue,
            source_name: sourceName,
            weight: weightMap.get(sourceValue) ?? 0,
            title: item.Name,
            poster: client.getImageUrl(item.Id, 'Primary', undefined, client.isProxyEnabled() ? proxyToken || undefined : undefined),
            episodes: [],
            episodes_titles: [],
            year: item.ProductionYear?.toString() || '',
            desc: item.Overview || '',
            type_name: item.Type === 'Movie' ? '电影' : '电视剧',
            douban_id: 0,
          }));
        } catch (error) {
          console.error(`[Search] 搜索 ${embyConfig.name} 失败:`, error);
          return [];
        }
      })(),
      new Promise<any[]>((_, reject) =>
        setTimeout(() => reject(new Error(`${embyConfig.name} timeout`)), 20000)
      ),
    ]).catch((error) => {
      console.error(`[Search] 搜索 ${embyConfig.name} 超时:`, error);
      return [];
    })
  );

  // 搜索 OpenList
  const openlistPromise = hasOpenList
    ? Promise.race([
        (async () => {
          try {
            const { getCachedMetaInfo, setCachedMetaInfo } = await import('@/lib/openlist-cache');
            const { getTMDBImageUrl } = await import('@/lib/tmdb.search');
            const { db } = await import('@/lib/db');

            let metaInfo = getCachedMetaInfo();

            if (!metaInfo) {
              const metainfoJson = await db.getGlobalValue('video.metainfo');
              if (metainfoJson) {
                metaInfo = JSON.parse(metainfoJson);
                if (metaInfo) {
                  setCachedMetaInfo(metaInfo);
                }
              }
            }

            if (metaInfo && metaInfo.folders) {
              return Object.entries(metaInfo.folders)
                .filter(([folderName, info]: [string, any]) => {
                  const matchFolder = folderName.toLowerCase().includes(query.toLowerCase());
                  const matchTitle = info.title.toLowerCase().includes(query.toLowerCase());
                  return matchFolder || matchTitle;
                })
                .map(([folderName, info]: [string, any]) => ({
                  id: folderName,
                  source: 'openlist',
                  source_name: '私人影库',
                  weight: weightMap.get('openlist') ?? 0,
                  title: info.title,
                  poster: getTMDBImageUrl(info.poster_path),
                  episodes: [],
                  episodes_titles: [],
                  year: info.release_date.split('-')[0] || '',
                  desc: info.overview,
                  type_name: info.media_type === 'movie' ? '电影' : '电视剧',
                  douban_id: 0,
                }));
            }
            return [];
          } catch (error) {
            console.error('[Search] 搜索 OpenList 失败:', error);
            return [];
          }
        })(),
        new Promise<any[]>((_, reject) =>
          setTimeout(() => reject(new Error('OpenList timeout')), 20000)
        ),
      ]).catch((error) => {
        console.error('[Search] 搜索 OpenList 超时:', error);
        return [];
      })
    : Promise.resolve([]);

  // API 源搜索
  const searchPromises = apiSites.map((site) =>
    Promise.race([
      searchFromApi(site, query),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${site.name} timeout`)), 20000)
      ),
    ]).catch((err) => {
      console.warn(`搜索失败 ${site.name}:`, err.message);
      return [];
    })
  );

  // 脚本源搜索
  const scriptSummaries = await listEnabledSourceScripts();
  const scriptPromises = scriptSummaries.map((script) =>
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
          console.error(`[Search] 搜索脚本 ${script.name} 失败:`, error);
          return [];
        }
      })(),
      new Promise<any[]>((_, reject) =>
        setTimeout(() => reject(new Error(`${script.name} timeout`)), 20000)
      ),
    ]).catch((error) => {
      console.error(`[Search] 搜索脚本 ${script.name} 超时:`, error);
      return [];
    })
  );

  try {
    const allResults = await Promise.all([
      openlistPromise,
      ...embyPromises,
      ...searchPromises,
      ...scriptPromises,
    ]);

    const openlistResults = Array.isArray(allResults[0]) ? allResults[0] : [];
    const embyResultsArray = allResults.slice(1, 1 + embyPromises.length);
    const apiResults = allResults.slice(1 + embyPromises.length, 1 + embyPromises.length + searchPromises.length);
    const scriptResults = allResults.slice(1 + embyPromises.length + searchPromises.length);

    const embyResults = embyResultsArray.filter(Array.isArray).flat();
    const apiResultsFlat = apiResults.filter(Array.isArray).flat();
    const scriptResultsFlat = scriptResults.filter(Array.isArray).flat();

    let flattenedResults = [...openlistResults, ...embyResults, ...apiResultsFlat, ...scriptResultsFlat];

    flattenedResults = flattenedResults.map((result) => ({
      ...result,
      weight: result.weight ?? (weightMap.get(result.source) ?? 0),
    }));

    if (!config.SiteConfig.DisableYellowFilter) {
      flattenedResults = flattenedResults.filter((result) => {
        const typeName = result.type_name || '';
        return !yellowWords.some((word: string) => typeName.includes(word));
      });
    }

    // 按权重排序
    flattenedResults.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

    // ==================== 📊 调试日志打印 ====================
    console.log(`[Search Debug] 关键词: "${query}" | 过滤前原始数据总数: ${flattenedResults.length}`);
    if (flattenedResults.length > 0) {
      console.log(
        `[Search Debug] 原始标题样例:`,
        flattenedResults.slice(0, 5).map((i) => i.title || i.vod_name || i.name)
      );
    }
    // =========================================================

    // ==================== 🔍 智能关键词二次过滤 ====================
    if (query && query.trim() !== '') {
      // 支持按空格切分多关键词匹配
      const cleanKeywords = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

      flattenedResults = flattenedResults.filter((item) => {
        if (!item) return false;
        const itemTitle = String(item.title || item.vod_name || item.name || '').toLowerCase();
        if (!itemTitle) return false;

        // 要求标题中包含搜索关键词的每一个拆分词
        return cleanKeywords.every((kw) => itemTitle.includes(kw));
      });
    }
    // ==============================================================

    console.log(`[Search Debug] 过滤后匹配到的数据总数: ${flattenedResults.length}`);

    const cacheTime = await getCacheTime();

    if (flattenedResults.length === 0) {
      return NextResponse.json({ results: [] }, { status: 200 });
    }

    return NextResponse.json(
      { results: flattenedResults },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Netlify-Vary': 'query',
        },
      }
    );
  } catch (error) {
    console.error('[Search] 搜索结果处理失败:', error);
    return NextResponse.json({ error: '搜索失败' }, { status: 500 });
  }
}
