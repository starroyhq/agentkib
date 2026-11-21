import { useSessionPlatform, type SessionPlatform } from "../../session-platform";

type SearchFilter = {
  id: string;
  label: string;
  groupLabel: string;
  value: string;
  selectedLabel: string;
  onChange(value: string): void;
  options: { value: string; label: string }[];
};

export function HistorySearchFilters({
  mode,
  sourceLabel,
  filters,
  archived,
}: {
  mode: SessionPlatform["historySearch"]["filter"];
  sourceLabel: string;
  filters: SearchFilter[];
  archived: { checked: boolean; label: string; onChange(value: boolean): void };
}) {
  const {
    components: {
      NativeCheckbox,
      NativeSelect,
      NativeSelectOption,
      Select,
      SelectContent,
      SelectGroup,
      SelectItem,
      SelectLabel,
      SelectTrigger,
      SelectValue,
    },
  } = useSessionPlatform();
  if (mode === "native-select") {
    return (
      <div className="flex flex-wrap gap-2">
        {filters.map((filter) => (
          <NativeSelect
            key={filter.id}
            aria-label={filter.label}
            value={filter.value}
            onChange={(event) => filter.onChange(event.target.value)}
          >
            <NativeSelectOption value="">{filter.label}</NativeSelectOption>
            {filter.options.map(({ value, label }) => (
              <NativeSelectOption key={value} value={value}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ))}
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={archived.checked}
            onChange={(event) => archived.onChange(event.target.checked)}
          />
          {archived.label}
        </label>
      </div>
    );
  }

  return (
    <fieldset className="space-y-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">{sourceLabel}</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {filters.map((filter) => {
          const all = `__all_${filter.id}__`;
          return (
            <Select
              key={filter.id}
              value={filter.value || all}
              onValueChange={(value) => filter.onChange(value === all ? "" : (value ?? ""))}
            >
              <SelectTrigger className="h-10 w-full" aria-label={filter.label}>
                <SelectValue>{filter.selectedLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{filter.groupLabel}</SelectLabel>
                  <SelectItem value={all}>{filter.label}</SelectItem>
                  {filter.options.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          );
        })}
      </div>
      <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <NativeCheckbox
          checked={archived.checked}
          onChange={(event) => archived.onChange(event.target.checked)}
        />
        {archived.label}
      </label>
    </fieldset>
  );
}
