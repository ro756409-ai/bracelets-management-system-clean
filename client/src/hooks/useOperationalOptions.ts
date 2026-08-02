import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";

export function useOperationalOptions(namespace: string) {
  const { currentBusinessIds } = useBusinessContext();
  const query = trpc.accountingV2.configurationListForBusinesses.useQuery({
    businessIds: currentBusinessIds,
    namespace,
  });
  return {
    ...query,
    options:
      query.data?.map(row => ({
        value: row.configKey,
        label: row.displayName,
      })) ?? [],
    values: query.data?.map(row => row.configKey) ?? [],
  };
}
