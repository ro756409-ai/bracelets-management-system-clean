export type AccountingMappingContext = {
  businessId: number;
  eventType: string;
  eventId: number;
  occurredAt: Date;
  payload: Record<string, unknown>;
};

export type JournalEntryDraft = {
  reference: string;
  lines: Array<{
    accountCode: string;
    direction: "debit" | "credit";
    amount: string;
    description?: string;
  }>;
};

export interface AccountingEventMapper {
  supports(eventType: string): boolean;
  map(context: AccountingMappingContext): JournalEntryDraft[];
}

export class AccountingMappingRegistry {
  private readonly mappers: AccountingEventMapper[] = [];

  register(mapper: AccountingEventMapper): void {
    this.mappers.push(mapper);
  }

  map(context: AccountingMappingContext): JournalEntryDraft[] {
    const mapper = this.mappers.find(candidate => candidate.supports(context.eventType));
    if (!mapper) return [];
    return mapper.map(context);
  }
}
