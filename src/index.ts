interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * TheMealDB MCP.
 *
 * Open meal/recipe database — search recipes by name, look up full recipes with
 * ingredients and instructions, filter by ingredient/category/cuisine, and list
 * available categories, cuisines, and ingredients. Keyless (uses the public test
 * key "1").
 */


const BASE = 'https://www.themealdb.com/api/json/v1/1';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_meals',
    description:
      'Search recipes by name in TheMealDB. Returns matching meals with ingredients, cuisine, category, thumbnail, truncated instructions, and a YouTube link. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Meal name or partial name, e.g. "arrabiata", "chicken".' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_meal',
    description:
      'Look up a single full recipe by its TheMealDB meal id — complete (untruncated) instructions, full ingredient list, tags, source URL, and YouTube link. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'TheMealDB meal id (idMeal), e.g. "52771".' },
      },
      required: ['id'],
    },
  },
  {
    name: 'filter_meals',
    description:
      'Filter recipes by ONE of: main ingredient, category, or cuisine (area). Returns a light list (id, name, thumbnail) — use get_meal for full details. Priority if multiple given: ingredient > category > area. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        ingredient: { type: 'string', description: 'Main ingredient, e.g. "chicken_breast", "salmon".' },
        category: { type: 'string', description: 'Category, e.g. "Seafood", "Dessert", "Vegetarian".' },
        area: { type: 'string', description: 'Cuisine / area, e.g. "Italian", "Mexican", "Canadian".' },
      },
    },
  },
  {
    name: 'list_options',
    description:
      'List the available filter values in TheMealDB: all categories, all cuisines (areas), or all ingredients. Use the returned values with filter_meals. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['categories', 'areas', 'ingredients'],
          description: 'Which list to return: "categories", "areas" (cuisines), or "ingredients".',
        },
      },
      required: ['type'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'search_meals':
        return searchMeals(args);
      case 'get_meal':
        return getMeal(args);
      case 'filter_meals':
        return filterMeals(args);
      case 'list_options':
        return listOptions(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function get(raw: Record<string, unknown>, key: string): string | null {
  const v = raw[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function zipIngredients(raw: Record<string, unknown>): Array<{ name: string; measure: string | null }> {
  const out: Array<{ name: string; measure: string | null }> = [];
  for (let i = 1; i <= 20; i++) {
    const name = get(raw, `strIngredient${i}`);
    if (!name) continue;
    out.push({ name, measure: get(raw, `strMeasure${i}`) });
  }
  return out;
}

function truncate(s: string | null, max: number): string | null {
  if (s == null) return null;
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

function compactMeal(raw: Record<string, unknown>, full = false) {
  const instructionsRaw = get(raw, 'strInstructions');
  const tagsRaw = get(raw, 'strTags');
  const base: Record<string, unknown> = {
    id: get(raw, 'idMeal'),
    name: get(raw, 'strMeal'),
    category: get(raw, 'strCategory'),
    area: get(raw, 'strArea'),
    thumbnail: get(raw, 'strMealThumb'),
    ingredients: zipIngredients(raw),
    instructions: full ? instructionsRaw : truncate(instructionsRaw, 500),
    youtube: get(raw, 'strYoutube'),
  };
  if (full) {
    base.tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];
    base.source = get(raw, 'strSource');
  }
  return base;
}

async function getJson(url: string): Promise<{ meals: Array<Record<string, unknown>> | null } | { error: string }> {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) return { error: `themealdb: ${res.status} ${(await res.text()).slice(0, 200)}` };
  const data = (await res.json()) as { meals: Array<Record<string, unknown>> | null };
  return data;
}

async function searchMeals(args: Record<string, unknown>): Promise<unknown> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return { error: 'provide a meal name', name: args.name ?? null };

  const data = await getJson(`${BASE}/search.php?s=${encodeURIComponent(name)}`);
  if ('error' in data) return data;
  const meals = Array.isArray(data.meals) ? data.meals : [];
  return {
    count: meals.length,
    meals: meals.slice(0, 25).map((m) => compactMeal(m)),
  };
}

async function getMeal(args: Record<string, unknown>): Promise<unknown> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return { error: 'provide a meal id', id: args.id ?? null };

  const data = await getJson(`${BASE}/lookup.php?i=${encodeURIComponent(id)}`);
  if ('error' in data) return data;
  const meals = Array.isArray(data.meals) ? data.meals : [];
  if (meals.length === 0) return { error: 'meal not found', id };
  return compactMeal(meals[0], true);
}

async function filterMeals(args: Record<string, unknown>): Promise<unknown> {
  const ingredient = typeof args.ingredient === 'string' ? args.ingredient.trim() : '';
  const category = typeof args.category === 'string' ? args.category.trim() : '';
  const area = typeof args.area === 'string' ? args.area.trim() : '';

  let qs: string;
  if (ingredient) qs = `i=${encodeURIComponent(ingredient)}`;
  else if (category) qs = `c=${encodeURIComponent(category)}`;
  else if (area) qs = `a=${encodeURIComponent(area)}`;
  else return { error: 'provide one of: ingredient, category, area' };

  const data = await getJson(`${BASE}/filter.php?${qs}`);
  if ('error' in data) return data;
  const meals = Array.isArray(data.meals) ? data.meals : [];
  return {
    count: meals.length,
    meals: meals.slice(0, 50).map((m) => ({
      id: get(m, 'idMeal'),
      name: get(m, 'strMeal'),
      thumbnail: get(m, 'strMealThumb'),
    })),
  };
}

async function listOptions(args: Record<string, unknown>): Promise<unknown> {
  const type = typeof args.type === 'string' ? args.type.trim() : '';
  if (type !== 'categories' && type !== 'areas' && type !== 'ingredients') {
    return { error: 'type must be one of: categories, areas, ingredients', type: args.type ?? null };
  }

  const qsByType: Record<string, string> = { categories: 'c=list', areas: 'a=list', ingredients: 'i=list' };
  const data = await getJson(`${BASE}/list.php?${qsByType[type]}`);
  if ('error' in data) return data;
  const rows = Array.isArray(data.meals) ? data.meals : [];

  if (type === 'ingredients') {
    const values = rows
      .map((r) => ({ name: get(r, 'strIngredient'), description: truncate(get(r, 'strDescription'), 150) }))
      .filter((v) => v.name);
    return { type, count: values.length, values };
  }

  const field = type === 'categories' ? 'strCategory' : 'strArea';
  const values = rows.map((r) => get(r, field)).filter((v): v is string => !!v);
  return { type, count: values.length, values };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
