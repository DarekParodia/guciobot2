import {getInsurgencyConfig} from './config';
import {getProxmoxClient} from './client';

export interface ContainerStatus {
  status: string;  // 'running' | 'stopped' | ...
  name: string;
  uptimeSeconds: number;
  cpuPercent: number;
  memBytes: number;
  maxMemBytes: number;
}

function containerHandle() {
  const insurgencyConfig = getInsurgencyConfig();
  const proxmox = getProxmoxClient(insurgencyConfig);
  return proxmox.nodes.$(insurgencyConfig.proxmoxNode)
      .lxc.$(insurgencyConfig.containerId);
}

export async function getStatus(): Promise<ContainerStatus> {
  const result = await containerHandle().status.current.$get();
  return {
    status: result.status,
    name: result.name ?? `CT ${result.vmid}`,
    uptimeSeconds: result.uptime ?? 0,
    cpuPercent: (result.cpu ?? 0) * 100,
    memBytes: result.mem ?? 0,
    maxMemBytes: result.maxmem ?? 0,
  };
}

export async function start(): Promise<void> {
  await containerHandle().status.start.$post();
}

export async function stop(): Promise<void> {
  await containerHandle().status.stop.$post();
}

// Free RAM on the Proxmox host node, in MB — used to guard against
// starting the container when the host itself is under memory pressure.
export async function getNodeFreeRamMb(): Promise<number> {
  const insurgencyConfig = getInsurgencyConfig();
  const proxmox = getProxmoxClient(insurgencyConfig);
  const result: {memory?: {free?: number}} =
      await proxmox.nodes.$(insurgencyConfig.proxmoxNode).status.$get();
  return (result.memory?.free ?? 0) / 1024 / 1024;
}
