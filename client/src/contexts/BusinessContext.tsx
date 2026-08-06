import { createContext, useContext, useState, useEffect, ReactNode, useMemo } from 'react';
import { trpc } from '@/lib/trpc';

interface Business {
  id: number;
  name: string;
  slug: string;
  groupId: number | null;
  isActive: boolean;
}

interface BusinessGroup {
  id: number;
  name: string;
  slug: string;
  businesses: Business[];
}

interface BusinessContextType {
  groups: BusinessGroup[];
  businesses: Business[];
  currentGroupId: number | undefined;
  setCurrentGroupId: (id: number | undefined) => void;
  currentGroup: BusinessGroup | undefined;
  /** Array of businessIds for the selected group (used in queries) */
  currentBusinessIds: number[] | undefined;
  /** Legacy: single businessId (undefined = all) - for backward compat */
  currentBusinessId: number | undefined;
  setCurrentBusinessId: (id: number | undefined) => void;
  isLoading: boolean;
}

const BusinessContext = createContext<BusinessContextType | undefined>(undefined);

const GROUP_STORAGE_KEY = 'selected_business_group_id';

export function BusinessProvider({ children }: { children: ReactNode }) {
  const [currentGroupId, setCurrentGroupIdState] = useState<number | undefined>(() => {
    const stored = localStorage.getItem(GROUP_STORAGE_KEY);
    return stored ? Number(stored) : undefined;
  });

  const { data: groupsData = [], isLoading } = trpc.businesses.groupsWithBusinesses.useQuery();

  // Validate stored groupId
  useEffect(() => {
    if (!isLoading && groupsData.length > 0) {
      if (currentGroupId === undefined) {
        // Default to first group
        const defaultId = groupsData[0].id;
        setCurrentGroupIdState(defaultId);
        localStorage.setItem(GROUP_STORAGE_KEY, String(defaultId));
      } else {
        const exists = groupsData.some(g => g.id === currentGroupId);
        if (!exists) {
          const defaultId = groupsData[0].id;
          setCurrentGroupIdState(defaultId);
          localStorage.setItem(GROUP_STORAGE_KEY, String(defaultId));
        }
      }
    }
  }, [groupsData, isLoading, currentGroupId]);

  const setCurrentGroupId = (id: number | undefined) => {
    setCurrentGroupIdState(id);
    if (id !== undefined) {
      localStorage.setItem(GROUP_STORAGE_KEY, String(id));
    } else {
      localStorage.removeItem(GROUP_STORAGE_KEY);
    }
  };

  const currentGroup = groupsData.find(g => g.id === currentGroupId) as BusinessGroup | undefined;

  // Compute businessIds for the selected group
  const currentBusinessIds = useMemo(() => {
    if (!currentGroupId || !currentGroup) return undefined;
    return currentGroup.businesses.map(b => b.id);
  }, [currentGroupId, currentGroup]);

  // All businesses flat list
  /**
   * Every brand the user may act on, whether or not it sits in a group.
   *
   * This used to be `groupsData.flatMap(g => g.businesses)`, which looks equivalent and is
   * not: getBusinessGroupsWithBusinesses attaches a brand to a group with
   * `b.groupId === g.id`, so a brand whose groupId is null appears in no group and vanished
   * from this list too. Screens that ask "which brands can I use" then saw none and locked
   * themselves — the goods receipt form kept its warehouse select disabled behind "choose
   * the brand first", with no brand to choose.
   *
   * `businesses.activeList` is scoped by tenant on the server and does not care about
   * groups, so it answers that question directly. Grouping stays with currentGroup, which is
   * what the header switcher is actually for.
   */
  const { data: allBusinesses = [] } = trpc.businesses.activeList.useQuery();
  const businesses = useMemo(() => allBusinesses as Business[], [allBusinesses]);

  // Legacy backward compat: currentBusinessId is undefined (we use businessIds array now)
  const currentBusinessId = undefined;
  const setCurrentBusinessId = (_id: number | undefined) => {
    // No-op, kept for backward compat
  };

  return (
    <BusinessContext.Provider value={{
      groups: groupsData as BusinessGroup[],
      businesses,
      currentGroupId,
      setCurrentGroupId,
      currentGroup,
      currentBusinessIds,
      currentBusinessId,
      setCurrentBusinessId,
      isLoading,
    }}>
      {children}
    </BusinessContext.Provider>
  );
}

export function useBusinessContext() {
  const context = useContext(BusinessContext);
  if (!context) {
    throw new Error('useBusinessContext must be used within a BusinessProvider');
  }
  return context;
}
