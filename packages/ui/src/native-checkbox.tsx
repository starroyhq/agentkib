import type * as React from "react";

function NativeCheckbox({ type: _type, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="native-checkbox" type="checkbox" {...props} />;
}

export { NativeCheckbox };
