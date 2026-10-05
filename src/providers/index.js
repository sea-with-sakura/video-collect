import { aliyunProvider } from "./aliyun-provider.js";
import { quarkProvider } from "./quark-provider.js";

const providers = new Map([
  [quarkProvider.id, quarkProvider],
  [aliyunProvider.id, aliyunProvider],
]);

export function listProviders() {
  return [...providers.values()].map((provider) => ({
    id: provider.id,
    name: provider.name,
    displayName: provider.displayName,
    category: provider.category,
    status: provider.status,
    capabilities: provider.capabilities,
    auth: provider.auth,
    limits: provider.limits,
  }));
}

export function getProvider(providerId) {
  return providers.get(providerId);
}
