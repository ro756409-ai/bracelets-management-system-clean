import { useMemo } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  GOVERNORATE_NAMES,
  citiesOf,
  isKnownCity,
} from "@shared/egyptLocations";

/** Sentinel for "no city chosen". Radix SelectItem rejects an empty string value. */
const NO_CITY = "__none__";

type Props = {
  governorate: string;
  city: string;
  onGovernorateChange: (value: string) => void;
  onCityChange: (value: string) => void;
  /** Governorates the business has curated, if any. Empty means "use the full list". */
  configuredGovernorates?: readonly string[];
  isLoading?: boolean;
  isError?: boolean;
  disabled?: boolean;
};

/**
 * Governorate → city, where picking a governorate narrows the cities.
 *
 * Both fields used to be wrong in the same way. The governorate list came from a
 * per-business configuration table nobody had filled in, so the dropdown was empty and the
 * employee could not set a governorate at all. The city was a free text box, so the same
 * markaz arrived spelled several ways and the courier export had to guess.
 *
 * The configured list still wins when a business has one — a merchant shipping only to
 * Cairo and Giza should see two options, not twenty-seven — and falls back to the full
 * national list otherwise. Cities always come from the shared data, keyed off the chosen
 * governorate.
 */
export function GovernorateCitySelect({
  governorate,
  city,
  onGovernorateChange,
  onCityChange,
  configuredGovernorates,
  isLoading = false,
  isError = false,
  disabled = false,
}: Props) {
  const governorates = useMemo(() => {
    const configured = (configuredGovernorates ?? []).filter(Boolean);
    if (configured.length > 0) return configured;
    return GOVERNORATE_NAMES;
  }, [configuredGovernorates]);

  const cities = useMemo(() => citiesOf(governorate), [governorate]);

  // An order can carry a governorate this list predates (imported years ago, or a spelling
  // the business configured and later removed). Showing an empty select would look like the
  // order has no governorate and invite the employee to overwrite a correct value, so the
  // stored one is appended rather than dropped.
  const governorateOptions = useMemo(() => {
    if (governorate && !governorates.includes(governorate)) {
      return [...governorates, governorate];
    }
    return governorates;
  }, [governorates, governorate]);

  // Same for a city the list doesn't name — every village is not in here by design.
  const cityIsFreeText = !!city && !isKnownCity(governorate, city);
  const cityOptions = useMemo(
    () => (cityIsFreeText ? [...cities, city] : cities),
    [cities, city, cityIsFreeText]
  );

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <Label>
          المحافظة <span className="text-destructive">*</span>
        </Label>
        {isLoading ? (
          <div className="mt-1 flex h-9 items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            جاري تحميل المحافظات...
          </div>
        ) : (
          <Select
            value={governorate || undefined}
            onValueChange={onGovernorateChange}
            disabled={disabled}
          >
            <SelectTrigger
              className={`mt-1 w-full ${!governorate ? "border-destructive/30 bg-destructive/10" : ""}`}
            >
              <SelectValue placeholder="اختر المحافظة..." />
            </SelectTrigger>
            <SelectContent className="max-h-[45vh]">
              {governorateOptions.map(g => (
                <SelectItem key={g} value={g}>
                  {g}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {isError && (
          <p className="mt-1 flex items-center gap-1 text-xs text-[var(--warning)]">
            <AlertCircle className="h-3 w-3" />
            تعذّر تحميل محافظات النشاط — القائمة الكاملة معروضة
          </p>
        )}
        {!isLoading && !governorate && (
          <p className="mt-1 text-xs text-destructive">مطلوبة</p>
        )}
      </div>

      <div>
        <Label>المدينة / المركز</Label>
        {!governorate ? (
          <div className="mt-1 flex h-9 items-center rounded-md border border-dashed px-3 text-sm text-muted-foreground">
            اختر المحافظة أولاً
          </div>
        ) : cities.length === 0 ? (
          // No city list for this governorate — usually one the business configured itself.
          // Free text beats blocking the employee on data we don't have.
          <Input
            value={city}
            onChange={e => onCityChange(e.target.value)}
            placeholder="اكتب المدينة أو المركز..."
            className="mt-1"
            disabled={disabled}
          />
        ) : (
          <Select
            value={city || NO_CITY}
            onValueChange={v => onCityChange(v === NO_CITY ? "" : v)}
            disabled={disabled}
          >
            <SelectTrigger className="mt-1 w-full">
              <SelectValue placeholder="اختر المدينة..." />
            </SelectTrigger>
            <SelectContent className="max-h-[45vh]">
              <SelectItem value={NO_CITY}>— بدون تحديد —</SelectItem>
              {cityOptions.map(c => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {cityIsFreeText && cities.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            «{city}» مش في قائمة {governorate} — محفوظة زي ما هي
          </p>
        )}
      </div>
    </div>
  );
}
