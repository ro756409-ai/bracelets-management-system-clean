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
const BUSINESS_STORAGE_KEY = 'selected_business_id';

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

  /**
   * Every brand the user may act on, whether or not it sits in a group.
   *
   * `businesses.activeList` is scoped by tenant on the server and does not care about groups,
   * so it lists exactly the businesses this session may use (and, for an employee, only the
   * ones they are allowed) — the canonical source the switcher picks from. It grows on its
   * own for a 2nd/3rd/4th business with no code change.
   */
  const { data: allBusinesses = [] } = trpc.businesses.activeList.useQuery();
  const businesses = useMemo(() => allBusinesses as Business[], [allBusinesses]);

  /**
   * Sprint 2 — Business is the unit of scope: "all businesses" (undefined) or one specific
   * business. Groups (currentGroupId/currentGroup) stay for backward compatibility
   * (useBrandOptions form pickers) but **no longer change the scope**. Employee isolation
   * stays enforced on the server (sessionBusinessIds) — this selection never widens access;
   * the server clamps any businessIds it receives.
   */
  const [currentBusinessId, setCurrentBusinessIdState] = useState<number | undefined>(() => {
    const stored = localStorage.getItem(BUSINESS_STORAGE_KEY);
    return stored ? Number(stored) : undefined; // undefined = كل الأنشطة
  });

  const setCurrentBusinessId = (id: number | undefined) => {
    setCurrentBusinessIdState(id);
    if (id != null) localStorage.setItem(BUSINESS_STORAGE_KEY, String(id));
    else localStorage.removeItem(BUSINESS_STORAGE_KEY);
  };

  // نشاط اتأرشف/اتشال أو مش من نطاق الجلسة → رجوع آمن لـ«كل الأنشطة» (مايفضلش اختيار شبح).
  useEffect(() => {
    if (currentBusinessId == null || businesses.length === 0) return;
    if (!businesses.some(b => b.id === currentBusinessId)) {
      setCurrentBusinessIdState(undefined);
      localStorage.removeItem(BUSINESS_STORAGE_KEY);
    }
  }, [businesses, currentBusinessId]);

  // النطاق الفعلي اللي بتستهلكه كل الشاشات — نفس العقد (number[] | undefined).
  // نشاط محدد → [id]، كل الأنشطة → undefined (كل أنشطة الـtenant، بيقصّها السيرفر للمسموح).
  const currentBusinessIds = useMemo(
    () => (currentBusinessId != null ? [currentBusinessId] : undefined),
    [currentBusinessId]
  );

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
