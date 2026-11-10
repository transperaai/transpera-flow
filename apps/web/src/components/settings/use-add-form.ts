"use client";

import { useState, useTransition, type FormEvent } from "react";

/**
 * An "Add …" form that keeps what was typed when the server says no. React 19 resets a `<form action={…}>` with uncontrolled inputs
 * once its action finishes, error or not, so a refused add used to empty every box. This submits by hand instead: the form is cleared
 * only after a successful add (and `onAdded` runs), and on an error the inputs keep their values beside the message.
 */
export function useAddForm<S extends { error?: string }>(action: (prev: S, form: FormData) => Promise<S>, initial: S, onAdded?: () => void) {
  const [state, setState] = useState<S>(initial);
  const [pending, start] = useTransition();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    start(async () => {
      const next = await action(state, data);
      setState(next);
      if (!next.error) {
        form.reset();
        onAdded?.();
      }
    });
  };
  return { state, pending, onSubmit };
}
