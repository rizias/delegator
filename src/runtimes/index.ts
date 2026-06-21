import { normalizeRuntimeId, mergedRuntimeDescriptors } from '../config.js';
import type { AnyRuntime, DelegatorConfig, RuntimeDescriptor } from '../types.js';
import { directApiRuntimeFromDescriptor } from './direct_api.js';
import { descriptorToAdapter } from './factory.js';

function isInProcessDescriptor(descriptor: RuntimeDescriptor): boolean {
  return descriptor.mode === 'direct-api' || !descriptor.command;
}

export function buildRuntimeRegistry(cfg: Pick<DelegatorConfig, 'runtimes'>): Record<string, AnyRuntime> {
  const descriptors = mergedRuntimeDescriptors(cfg);
  const out: Record<string, AnyRuntime> = {};
  for (const [idRaw, descriptor] of Object.entries(descriptors)) {
    const id = normalizeRuntimeId(idRaw);
    out[id] = isInProcessDescriptor(descriptor)
      ? directApiRuntimeFromDescriptor(id, descriptor)
      : descriptorToAdapter(id, descriptor);
  }
  return out;
}
