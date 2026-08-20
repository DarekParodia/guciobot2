import {execRconCommand} from './rcon';

export interface Scenario {
  id: string;
  modeLabel: string;
}

// The draft wheel's map names. These happen to match the prefix each
// scenario ID uses on the live server (e.g. "Scenario_Farmhouse_Ambush"),
// which was confirmed by querying the server's own `scenarios` RCON output
// — not the internal engine level codename (that one's inconsistent, e.g.
// Tideway's level is "Buhriz").
export const MAP_NAMES = [
  'Crossing', 'Farmhouse', 'Hideout', 'Refinery', 'Summit', 'Precinct',
  'Outskirts', 'Ministry', 'Hillside', 'Power Plant', 'Tideway', 'Tell',
  'Bab', 'Citadel', 'Gap', 'Prison', 'Lastlight', 'Trainyard', 'Forest',
] as const;

export type MapName = typeof MAP_NAMES[number];

const MAP_PREFIXES: Record<MapName, string> = {
  'Crossing': 'Crossing',
  'Farmhouse': 'Farmhouse',
  'Hideout': 'Hideout',
  'Refinery': 'Refinery',
  'Summit': 'Summit',
  'Precinct': 'Precinct',
  'Outskirts': 'Outskirts',
  'Ministry': 'Ministry',
  'Hillside': 'Hillside',
  'Power Plant': 'PowerPlant',
  'Tideway': 'Tideway',
  'Tell': 'Tell',
  'Bab': 'Bab',
  'Citadel': 'Citadel',
  'Gap': 'Gap',
  'Prison': 'Prison',
  'Lastlight': 'LastLight',
  'Trainyard': 'Trainyard',
  'Forest': 'Forest',
};

// Scenario variants that exist in the server's data but aren't real
// versus-mode matches (a tutorial level, the weapon range, a leftover test
// scenario) — never offered by the draft wheel.
const EXCLUDED_SCENARIO = /Tutorial|_Range$|Interception_Test/;

// `Scenario_<Map>_<Mode...>` for every map but one typo'd entry in the
// game's own data ("Scneario_Citadel_TDM_Small", transposed "ne") —
// matching both spellings means we don't silently drop that scenario from
// Citadel's pool. The map-name group is non-greedy so it stops at the
// first underscore, which works because none of MAP_PREFIXES' values
// contain one.
const SCENARIO_LINE = /^((?:Scenario|Scneario)_(\S+?)_(\S+)) \(level: /;

let cache: Map<MapName, Scenario[]>|null = null;

function humanizeMode(mode: string): string {
  return mode.replace(/_/g, ' ');
}

function parseScenarios(output: string): Map<MapName, Scenario[]> {
  const byMap = new Map<MapName, Scenario[]>();
  for (const mapName of MAP_NAMES) byMap.set(mapName, []);

  const prefixToMap = new Map(MAP_NAMES.map(name => [MAP_PREFIXES[name], name]));

  for (const line of output.split('\n')) {
    const match = line.match(SCENARIO_LINE);
    if (!match) continue;
    const [, id, mapPrefix, modeSuffix] = match;
    if (!id || !mapPrefix || !modeSuffix || EXCLUDED_SCENARIO.test(id)) continue;

    const mapName = prefixToMap.get(mapPrefix);
    if (!mapName) continue;  // a map on the server we don't offer (e.g. "Hold")

    byMap.get(mapName)!.push({id, modeLabel: humanizeMode(modeSuffix)});
  }
  return byMap;
}

// Fetches (and memoizes for the process lifetime) the server's real
// scenario list via RCON, grouped by draft-wheel map name. The game's mode
// list isn't uniform per map, so this is what lets the draft only ever
// pick a map+mode combination the server can actually run.
export async function getScenariosByMap(
    host: string, port: number, password: string): Promise<Map<MapName, Scenario[]>|null> {
  if (cache) return cache;

  const output = await execRconCommand(host, port, password, 'scenarios');
  if (output === null) return null;

  cache = parseScenarios(output);
  return cache;
}
