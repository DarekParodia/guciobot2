import {clearlist} from './clearlist';
import {losowanie} from './losowanie';
import {nowplaying} from './nowplaying';
import {ping} from './ping';
import {play} from './play';
import {playnext} from './playnext';
import {queue} from './queue';
import {shuffle} from './shuffle';
import {skip} from './skip';
import {startInsurgency} from './startInsurgency';
import {statusInsurgency} from './statusInsurgency';
import {stopInsurgency} from './stopInsurgency';
import type {Command} from './types';

export type {Command} from './types';

// Keyed by slash command name. To add a command: create a `src/commands/<name>.ts`
// exporting a `Command`, then register it here.
export const commands: Record<string, Command> = {
  ping,
  play,
  playnext,
  skip,
  kolejka: queue,
  coleci: nowplaying,
  shuffle,
  clearlist,
  start_insurgency: startInsurgency,
  stop_insurgency: stopInsurgency,
  status_insurgency: statusInsurgency,
  losowanie,
};
