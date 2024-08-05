import { Query, Ref, isDescribeQuery } from '@uwdata/mosaic-sql';
import { QueryResult } from './util/query-result.js';

function wait(callback) {
  const method = typeof requestAnimationFrame !== 'undefined'
    ? requestAnimationFrame
    : typeof setImmediate !== 'undefined' ? setImmediate : setTimeout;
  // @ts-ignore
  return method(callback);
}

/**
 * Create a consolidator to combine structurally compatible queries.
 * @param {*} enqueue Query manager enqueue method
 * @param {*} cache Client-side query cache (sql -> data)
 * @param {*} record Query recorder function
 * @returns A consolidator object
 */
export function consolidator(enqueue, cache, record) {
  let pending = [];
  let id = 0;

  function run() {
    // group queries into bundles that can be consolidated
    const groups = entryGroups(pending, cache);
    pending = [];
    id = 0;

    // build and issue consolidated queries
    for (const group of groups) {
      consolidate(group, enqueue, record);
      processResults(group, cache);
    }
  }

  return {
    add(entry, priority) {
      if (entry.request.type === 'arrow') {
        // wait one frame, gather an ordered list of queries
        // only Apache Arrow is supported, so we can project efficiently
        id = id || wait(() => run());
        pending.push({ entry, priority, index: pending.length });
      } else {
        enqueue(entry, priority);
      }
    }
  }
}

/**
 * Segment query requests into consolidation-compatible groups.
 * @param {*} entries Query request entries ({ request, result } objects)
 * @returns An array of grouped entry arrays
 */
function entryGroups(entries, cache) {
  const groups = [];
  const groupMap = new Map;

  for (const query of entries) {
    const { entry: { request } } = query;
    const key = consolidationKey(request.query, cache);
    if (!groupMap.has(key)) {
      const list = [];
      groups.push(list);
      groupMap.set(key, list);
    }
    groupMap.get(key).push(query);
  }

  return groups;
}

/**
 * Generate a key string for query consolidation.
 * Queries with matching keys are conosolidation-compatible.
 * If a query is found in the cache, it is exempted from consolidation,
 * which is indicated by returning the precise query SQL as the key.
 * @param {*} query The input query.
 * @param {*} cache The query cache (sql -> data).
 * @returns a key string
 */
function consolidationKey(query, cache) {
  const sql = `${query}`;
  if (query instanceof Query && !cache.get(sql)) {
    if (
      // @ts-ignore
      query.orderby().length || query.where().length ||
      // @ts-ignore
      query.qualify().length || query.having().length
    ) {
      // do not try to analyze if query includes clauses
      // that may refer to *derived* columns we can't resolve
      return sql;
    }

    // create a derived query stripped of selections
    const q = query.clone().$select('*');

    // check group by criteria for compatibility
    // queries may refer to *derived* columns as group by criteria
    // we resolve these against the true grouping expressions
    const groupby = query.groupby();
    // @ts-ignore
    if (groupby.length) {
      const map = {}; // expression map (as -> expr)
      // @ts-ignore
      query.select().forEach(({ as, expr }) => map[as] = expr);
      // @ts-ignore
      q.$groupby(groupby.map(e => (e instanceof Ref && map[e.column]) || e));
    }

    // key is just the transformed query as SQL
    return `${q}`;
  } else {
    // can not analyze query, simply return as string
    return sql;
  }
}

/**
 * Issue queries, consolidating where possible.
 * @param {*} group Array of bundled query entries
 * @param {*} enqueue Add entry to query queue
 * @param {*} record Query recorder function
 */
function consolidate(group, enqueue, record) {
  if (shouldConsolidate(group)) {
    // issue a single consolidated query
    enqueue({
      request: {
        type: 'arrow',
        cache: false,
        record: false,
        query: (group.query = consolidatedQuery(group, record))
      },
      result: (group.result = new QueryResult())
    });
  } else {
    // issue queries directly
    for (const { entry, priority } of group) {
      enqueue(entry, priority);
    }
  }
}

/**
 * Check if a group contains multiple distinct queries.
 * @param {*} group Array of bundled query entries
 * @returns false if group contains a single (possibly repeated) query,
 *  otherwise true
 */
function shouldConsolidate(group) {
  if (group.length > 1) {
    const sql = `${group[0].entry.request.query}`;
    for (let i = 1; i < group.length; ++i) {
      if (sql !== `${group[i].entry.request.query}`) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Create a consolidated query for a group.
 * @param {*} group Array of bundled query entries
 * @param {*} record Query recorder function
 * @returns A consolidated Query instance
 */
function consolidatedQuery(group, record) {
  const maps = group.maps = [];
  const fields = new Map;

  // gather select fields
  for (const item of group) {
    const { query } = item.entry.request;
    const fieldMap = [];
    maps.push(fieldMap);
    for (const { as, expr } of query.select()) {
      const e = `${expr}`;
      if (!fields.has(e)) {
        fields.set(e, [`col${fields.size}`, expr]);
      }
      const [name] = fields.get(e);
      fieldMap.push([name, as]);
    }
    record(`${query}`);
  }

  // use a cloned query as a starting point
  const query = group[0].entry.request.query.clone();

  // update group by statement as needed
  const groupby = query.groupby();
  if (groupby.length) {
    const map = {};
    group.maps[0].forEach(([name, as]) => map[as] = name);
    query.$groupby(groupby.map(e => (e instanceof Ref && map[e.column]) || e));
  }

  // update select statement and return
  return query.$select(Array.from(fields.values()));
}

/**
 * Process query results, dispatch results to original requests
 * @param {*} group Array of query requests
 * @param {*} cache Client-side query cache (sql -> data)
 */
async function processResults(group, cache) {
  const { maps, query, result } = group;

  // exit early if no consolidation performed
  // in this case results are passed directly
  if (!maps) return;

  // await consolidated query result, pass errors if needed
  let data;
  try {
    data = await result;
  } catch (err) {
    // pass error to consolidated queries
    for (const { entry } of group) {
      entry.result.reject(err);
    }
    return;
  }

  // extract result for each query in the consolidation group
  // update cache and pass extract to original issuer
  const describe = isDescribeQuery(query);
  group.forEach(({ entry }, index) => {
    const { request, result } = entry;
    const map = maps[index];
    const extract = describe && map ? filterResult(data, map)
      : map ? projectResult(data, map)
      : data;
    if (request.cache) {
      cache.set(String(request.query), extract);
    }
    result.fulfill(extract);
  });
}

/**
 * Project a consolidated result to a client result
 * @param {*} data Consolidated query result, as an Apache Arrow Table
 * @param {*} map Column name map as [source, target] pairs
 * @returns the projected Apache Arrow table
 */
function projectResult(data, map) {
  const cols = {};
  for (const [name, as] of map) {
    cols[as] = data.getChild(name);
  }
  return new data.constructor(cols);
}

/**
 * Filter a consolidated describe query result to a client result
 * @param {*} data Consolidated query result
 * @param {*} map Column name map as [source, target] pairs
 * @returns the filtered table data
 */
function filterResult(data, map) {
  const lookup = new Map(map);
  const result = [];
  for (const d of data) {
    if (lookup.has(d.column_name)) {
      result.push({ ...d, column_name: lookup.get(d.column_name) })
    }
  }
  return result;
}
