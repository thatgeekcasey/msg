import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from "react";
import { AVATAR_TOO_LARGE, MAX_AVATAR_SIZE } from "@ember/protocol";
import type { ChosenPhoto } from "@/lib/api";
import { avatarVariantOf } from "@/lib/previews";

/** A photo picked in a form that sends it with the rest of the form, and what the form shows of it. */
export interface PhotoChoice {
  /** The form's file field. */
  input: RefObject<HTMLInputElement | null>;
  /** The address the photo shows from while it's chosen, or null for none. */
  preview: string | null;
  /** Why the photo picked last isn't kept, or null. */
  refusal: string | null;
  /** Takes the photo the file field has picked, or leaves none where it has none. */
  choose: (event: ChangeEvent<HTMLInputElement>) => void;
  /** Takes `file` as the photo, as a picture field picks one, or with none, lets go of the photo chosen. */
  take: (file: File | undefined) => void;
  /** Lets go of the photo, saying why it can't be had, so the form can be sent without it. */
  refuse: (reason: string) => void;
  /** The photo to send with the form, once its variant is made, or null when none is chosen. */
  photo: () => Promise<ChosenPhoto | null>;
}

/**
 * The photo someone picks in the setup, join, bot or agent form, which shows at once, as Campfire's
 * upload_preview_controller.js shows it, while its variant is made (`avatarVariantOf`). A photo over 16
 * MB is refused at once, and the form shows nothing for a field that has nothing picked, where
 * Campfire's keeps showing a photo it won't send.
 */
export function useChosenPhoto(): PhotoChoice {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const chosen = useRef<Promise<ChosenPhoto> | null>(null);

  // A preview's address is let go of once another takes its place, or the form goes.
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  function refuse(reason: string) {
    if (input.current) input.current.value = "";
    chosen.current = null;
    setPreview(null);
    setRefusal(reason);
  }

  function take(file: File | undefined) {
    if (file && file.size > MAX_AVATAR_SIZE) return refuse(AVATAR_TOO_LARGE);
    setRefusal(null);
    chosen.current = file ? avatarVariantOf(file).then((variant) => ({ file, variant })) : null;
    setPreview(file ? URL.createObjectURL(file) : null);
  }

  const choose = (event: ChangeEvent<HTMLInputElement>) => take(event.target.files?.[0]);

  return { input, preview, refusal, choose, take, refuse, photo: async () => chosen.current };
}
