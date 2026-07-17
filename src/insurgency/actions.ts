import {recordAction} from './audit';
import type {InsurgencyConfig} from './config';
import * as lxc from './lxc';

export interface ActionResult {
  ok: boolean;
  message: string;
}

// Shared by /start_insurgency and the status panel's Start button — keeps
// the "already running" / RAM-safeguard checks in one place instead of two
// copies that can drift.
export async function performStart(
    user: {id: string; tag: string},
    insurgencyConfig: InsurgencyConfig): Promise<ActionResult> {
  const status = await lxc.getStatus();
  if (status.status === 'running') {
    return {ok: false, message: 'Insurgency już śmiga, nie ma co odpalać drugi raz.'};
  }

  const freeRamMb = await lxc.getNodeFreeRamMb();
  if (freeRamMb < insurgencyConfig.minFreeRamMb) {
    return {
      ok: false,
      message: `Za mało wolnego RAM-u na hoście: **${freeRamMb.toFixed(0)} MB** dostępne, wymagane **${
          insurgencyConfig
              .minFreeRamMb} MB**. Kontener nie został uruchomiony. Zapytaj dara o wlaczenie`,
    };
  }

  await lxc.start();
  recordAction('start', user);
  return {ok: true, message: 'Insurgency sie odpala'};
}

// Shared by /stop_insurgency and the status panel's Stop button.
export async function performStop(
    user: {id: string; tag: string},
    insurgencyConfig: InsurgencyConfig): Promise<ActionResult> {
  const status = await lxc.getStatus();
  if (status.status !== 'running') {
    return {ok: false, message: 'Insurgency już stoi, nie ma czego gasić.'};
  }

  await lxc.stop();
  recordAction('stop', user);
  return {ok: true, message: 'Insurgency zgaszone.'};
}
