import { Children, Fragment, isValidElement, useMemo, useRef, type ComponentProps, type ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

type Option = { value: string; label: ReactNode; disabled: boolean };

function optionsFromChildren(children: ReactNode): Option[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ value?: string; disabled?: boolean; children?: ReactNode }>(child)) return [];
    if (child.type === Fragment) return optionsFromChildren(child.props.children);
    return [{ value: String(child.props.value ?? ""), label: child.props.children, disabled: child.props.disabled ?? false }];
  });
}

type MenuSelectProps = Omit<ComponentProps<typeof SelectTrigger>, "onChange" | "value" | "defaultValue" | "multiple" | "size"> & {
  name?: string;
  required?: boolean;
  displayValue?: ReactNode;
  contentClassName?: string;
  value: string;
  onChange?: (event: { target: { value: string } }) => void;
};

/** Shared shadcn select for the app's controlled option menus. */
export function MenuSelect({ children, value, onChange, name, disabled, required, displayValue, contentClassName, className, ...props }: MenuSelectProps) {
  const incoming = optionsFromChildren(children);
  const previous = useRef<Option[]>([]);
  // Retain a stale draft/filter/group identity until the user explicitly changes it.
  if (value && !incoming.some((option) => option.value === value)) {
    incoming.unshift({ value, label: "Unavailable selection", disabled: true });
  }
  if (previous.current.length !== incoming.length || incoming.some((option, index) => {
    const old = previous.current[index];
    return option.value !== old?.value || option.label !== old.label || option.disabled !== old.disabled;
  })) previous.current = incoming;
  const options = previous.current;
  const items = useMemo(() => options.map(({ value, label }) => ({ value, label })), [options]);
  const renderedItems = useMemo(() => options.map((option) => (
    <SelectItem key={option.value} data-value={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>
  )), [options]);
  return (
    <Select value={value} onValueChange={(next) => { if (next !== null) onChange?.({ target: { value: next } }); }}
      items={items} name={name} disabled={disabled} required={required}>
      <SelectTrigger {...props} value={value} className={`app-select ${className ?? ""}`}>
        <SelectValue>{displayValue}</SelectValue>
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {renderedItems}
      </SelectContent>
    </Select>
  );
}
