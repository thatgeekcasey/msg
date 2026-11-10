import { useEffect, useRef, type RefObject } from "react";

/** Whether the component is still on the page, for answers that can come after it has gone. */
export function useMounted(): RefObject<boolean> {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
