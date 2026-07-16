"use client"
import * as React from "react"
import { Check, ChevronDown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface MultiSelectOption {
  value: string
  label: string
}

interface MultiSelectProps {
  options: MultiSelectOption[]
  /** Selected values. Empty array means "all" (no filtering). */
  selected: string[]
  onChange: (values: string[]) => void
  /** Trigger label when nothing is selected, e.g. "All Technicians". */
  allLabel: string
  className?: string
}

/**
 * Checkbox-style multi select styled to match SelectTrigger. Empty selection
 * means "all"; the "All …" row clears back to that state. Selecting stays
 * open so several options can be ticked in one visit.
 */
export function MultiSelect({ options, selected, onChange, allLabel, className }: MultiSelectProps) {
  const [open, setOpen] = React.useState(false)

  const toggle = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value]
    )
  }

  const triggerLabel =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? options.find((o) => o.value === selected[0])?.label || selected[0]
        : `${selected.length} selected`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "flex items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
          selected.length > 0 && "border-blue-500/50 text-foreground",
          className
        )}
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1 max-h-80 overflow-y-auto">
        <button
          type="button"
          className="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
          onClick={() => onChange([])}
        >
          <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
            {selected.length === 0 && <Check className="h-4 w-4" />}
          </span>
          {allLabel}
        </button>
        <div className="-mx-1 my-1 h-px bg-muted" />
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
            onClick={() => toggle(o.value)}
          >
            <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
              {selected.includes(o.value) && <Check className="h-4 w-4" />}
            </span>
            <span className="truncate text-left">{o.label}</span>
          </button>
        ))}
        {options.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted-foreground/60">No options yet.</p>
        )}
      </PopoverContent>
    </Popover>
  )
}
