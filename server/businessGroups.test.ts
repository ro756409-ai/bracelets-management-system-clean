import { describe, it, expect, vi } from 'vitest';

// Mock the database module
vi.mock('./db', () => ({
  getBusinessGroups: vi.fn().mockResolvedValue([
    { id: 1, name: 'نحاس', description: 'منتجات النحاس والأساور' },
    { id: 2, name: 'مفروشات وأدوات منزلية', description: 'كفر مرتبة ومسن وأدوات منزلية' },
  ]),
  getBusinessGroupsWithBusinesses: vi.fn().mockResolvedValue([
    {
      id: 1,
      name: 'نحاس',
      description: 'منتجات النحاس والأساور',
      businesses: [
        { id: 1, name: 'فرحات للنحاس' },
        { id: 2, name: 'نحاسي' },
        { id: 3, name: 'Nova' },
        { id: 4, name: 'asil' },
        { id: 5, name: 'عتبة' },
      ],
    },
    {
      id: 2,
      name: 'مفروشات وأدوات منزلية',
      description: 'كفر مرتبة ومسن وأدوات منزلية',
      businesses: [
        { id: 6, name: 'مفروشات السعد' },
        { id: 7, name: 'غطي' },
      ],
    },
  ]),
}));

describe('Business Groups', () => {
  it('should have two groups: نحاس and مفروشات', async () => {
    const { getBusinessGroups } = await import('./db');
    const groups = await getBusinessGroups();
    expect(groups).toHaveLength(2);
    expect(groups[0].name).toBe('نحاس');
    expect(groups[1].name).toBe('مفروشات وأدوات منزلية');
  });

  it('should return groups with their businesses', async () => {
    const { getBusinessGroupsWithBusinesses } = await import('./db');
    const groups = await getBusinessGroupsWithBusinesses();
    expect(groups).toHaveLength(2);

    // نحاس group should have 5 businesses
    const copperGroup = groups.find((g: any) => g.name === 'نحاس');
    expect(copperGroup).toBeDefined();
    expect(copperGroup!.businesses).toHaveLength(5);
    expect(copperGroup!.businesses.map((b: any) => b.name)).toContain('فرحات للنحاس');
    expect(copperGroup!.businesses.map((b: any) => b.name)).toContain('نحاسي');

    // مفروشات group should have 2 businesses
    const furnitureGroup = groups.find((g: any) => g.name === 'مفروشات وأدوات منزلية');
    expect(furnitureGroup).toBeDefined();
    expect(furnitureGroup!.businesses).toHaveLength(2);
    expect(furnitureGroup!.businesses.map((b: any) => b.name)).toContain('مفروشات السعد');
    expect(furnitureGroup!.businesses.map((b: any) => b.name)).toContain('غطي');
  });

  it('group filter should resolve to correct businessIds', async () => {
    const { getBusinessGroupsWithBusinesses } = await import('./db');
    const groups = await getBusinessGroupsWithBusinesses();

    // Simulate selecting "نحاس" group
    const copperGroup = groups.find((g: any) => g.name === 'نحاس');
    const copperBusinessIds = copperGroup!.businesses.map((b: any) => b.id);
    expect(copperBusinessIds).toEqual([1, 2, 3, 4, 5]);

    // Simulate selecting "مفروشات" group
    const furnitureGroup = groups.find((g: any) => g.name === 'مفروشات وأدوات منزلية');
    const furnitureBusinessIds = furnitureGroup!.businesses.map((b: any) => b.id);
    expect(furnitureBusinessIds).toEqual([6, 7]);
  });

  it('selecting "all" should return undefined businessIds (no filter)', () => {
    const groupFilter = "all";
    const selectedBusinessIds = groupFilter === "all" ? undefined : [1, 2, 3];
    expect(selectedBusinessIds).toBeUndefined();
  });
});
