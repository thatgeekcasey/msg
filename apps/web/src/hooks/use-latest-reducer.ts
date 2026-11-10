import { useCallback, useReducer, useRef, useState, type RefObject } from "react";

/**
 * `useReducer`, and the state as of the latest action, `latest`, which what's shown has only once it has
 * rendered: for what can't wait for that, as what a room's view leaves unsent as it goes can't.
 */
export function useLatestReducer<S, A>(reducer: (state: S, action: A) => S, initialState: () => S): [S, (action: A) => void, RefObject<S>] {
  const [initial] = useState(initialState);
  const [state, show] = useReducer(reducer, initial);
  const latest = useRef(initial);
  const dispatch = useCallback(
    (action: A) => {
      latest.current = reducer(latest.current, action);
      show(action);
    },
    [reducer],
  );
  return [state, dispatch, latest];
}
