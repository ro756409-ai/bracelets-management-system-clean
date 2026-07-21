import { useState, useRef, useEffect, useCallback } from "react";
import { Calendar, ChevronRight, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface DateRange {
  from: Date | null;
  to: Date | null;
}

interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  placeholder?: string;
}

const MONTHS_AR = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

const DAYS_AR = ["أحد", "اثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"];

function formatDate(d: Date): string {
  return `${d.getDate()} ${MONTHS_AR[d.getMonth()]} ${d.getFullYear()}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function startOfDay(d: Date): Date {
  const r = new Date(d); r.setHours(0, 0, 0, 0); return r;
}
function endOfDay(d: Date): Date {
  const r = new Date(d); r.setHours(23, 59, 59, 999); return r;
}

// Quick presets
function getPreset(key: string): DateRange {
  const now = new Date();
  switch (key) {
    case "today":
      return { from: startOfDay(now), to: endOfDay(now) };
    case "yesterday": {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case "last7":
      return { from: startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)), to: endOfDay(now) };
    case "last30":
      return { from: startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)), to: endOfDay(now) };
    case "thisWeek": {
      const day = now.getDay(); // 0=Sun
      const start = new Date(now); start.setDate(now.getDate() - day);
      return { from: startOfDay(start), to: endOfDay(now) };
    }
    case "thisMonth":
      return { from: startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: endOfDay(now) };
    case "thisYear":
      return { from: startOfDay(new Date(now.getFullYear(), 0, 1)), to: endOfDay(now) };
    case "lastYear":
      return {
        from: startOfDay(new Date(now.getFullYear() - 1, 0, 1)),
        to: endOfDay(new Date(now.getFullYear() - 1, 11, 31)),
      };
    default:
      return { from: null, to: null };
  }
}

const PRESETS = [
  { key: "today", label: "اليوم" },
  { key: "yesterday", label: "أمس" },
  { key: "last7", label: "آخر 7 أيام" },
  { key: "last30", label: "آخر 30 يوم" },
  { key: "thisWeek", label: "هذا الأسبوع" },
  { key: "thisMonth", label: "هذا الشهر" },
  { key: "thisYear", label: "هذه السنة" },
  { key: "lastYear", label: "السنة الماضية" },
];

function MonthCalendar({
  year,
  month,
  selecting,
  hovered,
  onDayClick,
  onDayHover,
}: {
  year: number;
  month: number;
  selecting: { from: Date | null; to: Date | null };
  hovered: Date | null;
  onDayClick: (d: Date) => void;
  onDayHover: (d: Date) => void;
}) {
  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const rangeFrom = selecting.from;
  const rangeTo = selecting.to ?? hovered;

  function isInRange(d: Date): boolean {
    if (!rangeFrom) return false;
    const lo = rangeFrom <= (rangeTo ?? rangeFrom) ? rangeFrom : (rangeTo ?? rangeFrom);
    const hi = rangeFrom <= (rangeTo ?? rangeFrom) ? (rangeTo ?? rangeFrom) : rangeFrom;
    return d >= lo && d <= hi;
  }

  function isStart(d: Date): boolean {
    if (!rangeFrom) return false;
    const lo = rangeFrom <= (rangeTo ?? rangeFrom) ? rangeFrom : (rangeTo ?? rangeFrom);
    return isSameDay(d, lo);
  }

  function isEnd(d: Date): boolean {
    if (!rangeFrom || !rangeTo) return false;
    const hi = rangeFrom <= rangeTo ? rangeTo : rangeFrom;
    return isSameDay(d, hi);
  }

  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

  return (
    <div className="min-w-[240px]">
      <div className="text-center font-bold text-sm mb-3 text-foreground">
        {MONTHS_AR[month]} {year}
      </div>
      <div className="grid grid-cols-7 gap-0 mb-1">
        {DAYS_AR.map(d => (
          <div key={d} className="text-center text-[10px] text-muted-foreground py-1 font-medium">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0">
        {cells.map((day, idx) => {
          if (!day) return <div key={`empty-${idx}`} />;
          const inRange = isInRange(day);
          const start = isStart(day);
          const end = isEnd(day);
          const today = isSameDay(day, new Date());
          return (
            <button
              key={day.toISOString()}
              type="button"
              onClick={() => onDayClick(day)}
              onMouseEnter={() => onDayHover(day)}
              className={[
                "relative h-8 w-full text-sm transition-colors select-none",
                inRange && !start && !end ? "bg-primary/15 text-foreground" : "",
                start ? "bg-primary text-primary-foreground rounded-r-full" : "",
                end && !isSameDay(day, rangeFrom!) ? "bg-primary text-primary-foreground rounded-l-full" : "",
                start && end ? "rounded-full" : "",
                !inRange && !start && !end ? "hover:bg-muted rounded-full" : "",
                today && !start && !end ? "font-bold underline" : "",
              ].join(" ")}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function DateRangePicker({ value, onChange, placeholder = "اختر نطاق زمني" }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [selecting, setSelecting] = useState<{ from: Date | null; to: Date | null }>({ from: null, to: null });
  const [hovered, setHovered] = useState<Date | null>(null);
  const [activePreset, setActivePreset] = useState<string | null>(null);

  // Show current month on left, next month on right
  const today = new Date();
  const [leftYear, setLeftYear] = useState(today.getFullYear());
  const [leftMonth, setLeftMonth] = useState(today.getMonth());

  const rightYear = leftMonth === 11 ? leftYear + 1 : leftYear;
  const rightMonth = leftMonth === 11 ? 0 : leftMonth + 1;

  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Sync selecting with value when opening
  useEffect(() => {
    if (open) {
      setSelecting({ from: value.from, to: value.to });
      setActivePreset(null);
    }
  }, [open]);

  function handleDayClick(day: Date) {
    setActivePreset(null);
    if (!selecting.from || (selecting.from && selecting.to)) {
      // Start new selection
      setSelecting({ from: startOfDay(day), to: null });
    } else {
      // Complete selection
      const from = selecting.from;
      if (day < from) {
        setSelecting({ from: startOfDay(day), to: endOfDay(from) });
      } else {
        setSelecting({ from, to: endOfDay(day) });
      }
    }
  }

  function handlePreset(key: string) {
    const range = getPreset(key);
    setSelecting(range);
    setActivePreset(key);
  }

  function handleApply() {
    if (selecting.from) {
      onChange({ from: selecting.from, to: selecting.to ?? endOfDay(selecting.from) });
    }
    setOpen(false);
  }

  function handleReset() {
    setSelecting({ from: null, to: null });
    setActivePreset(null);
    onChange({ from: null, to: null });
    setOpen(false);
  }

  function prevMonth() {
    if (leftMonth === 0) { setLeftMonth(11); setLeftYear(y => y - 1); }
    else setLeftMonth(m => m - 1);
  }
  function nextMonth() {
    if (leftMonth === 11) { setLeftMonth(0); setLeftYear(y => y + 1); }
    else setLeftMonth(m => m + 1);
  }

  // Display label
  let displayLabel = placeholder;
  if (value.from && value.to) {
    if (isSameDay(value.from, value.to)) {
      displayLabel = formatDate(value.from);
    } else {
      displayLabel = `${formatDate(value.from)} - ${formatDate(value.to)}`;
    }
  } else if (value.from) {
    displayLabel = formatDate(value.from);
  }

  return (
    <div className="relative" ref={ref} dir="rtl">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-background hover:bg-muted transition-colors text-sm text-foreground min-w-[200px] justify-between"
      >
        <span className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className={value.from ? "text-foreground" : "text-muted-foreground"}>{displayLabel}</span>
        </span>
      </button>

      {open && (
        <div className="absolute top-full mt-2 right-0 z-50 bg-popover border rounded-xl shadow-xl p-4 flex gap-4"
          style={{ minWidth: 580 }}
        >
          {/* Presets */}
          <div className="flex flex-col gap-1 min-w-[130px] border-l pl-4">
            <p className="text-xs font-semibold text-muted-foreground mb-1">اختيارات سريعة</p>
            {PRESETS.map(p => (
              <button
                key={p.key}
                type="button"
                onClick={() => handlePreset(p.key)}
                className={[
                  "text-sm text-right px-3 py-1.5 rounded-lg transition-colors",
                  activePreset === p.key
                    ? "bg-primary text-primary-foreground font-medium"
                    : "hover:bg-muted text-foreground",
                ].join(" ")}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Calendars */}
          <div className="flex flex-col gap-3 flex-1">
            <div className="flex items-center justify-between mb-1">
              <button type="button" onClick={prevMonth} className="p-1 hover:bg-muted rounded">
                <ChevronRight className="w-4 h-4" />
              </button>
              <div className="flex gap-8">
                <MonthCalendar
                  year={leftYear}
                  month={leftMonth}
                  selecting={selecting}
                  hovered={hovered}
                  onDayClick={handleDayClick}
                  onDayHover={setHovered}
                />
                <MonthCalendar
                  year={rightYear}
                  month={rightMonth}
                  selecting={selecting}
                  hovered={hovered}
                  onDayClick={handleDayClick}
                  onDayHover={setHovered}
                />
              </div>
              <button type="button" onClick={nextMonth} className="p-1 hover:bg-muted rounded">
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t pt-3 mt-1">
              <div className="text-xs text-muted-foreground">
                {selecting.from && (
                  <span>
                    {formatDate(selecting.from)}
                    {selecting.to && !isSameDay(selecting.from, selecting.to) && ` — ${formatDate(selecting.to)}`}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleReset}>
                  إعادة تعيين
                </Button>
                <Button
                  size="sm"
                  onClick={handleApply}
                  disabled={!selecting.from}
                  className="bg-primary text-primary-foreground"
                >
                  تطبيق
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
