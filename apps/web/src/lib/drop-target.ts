import type { DragEvent } from "react";

/**
 * Campfire's drop_target_controller.js, on the messages and the composer: anything dragged over an
 * element with these handlers can be dropped there, as a copy, and the files dropped go to `onFiles`,
 * rather than the browser opening them in place of the page.
 */
export function dropTarget(onFiles: (files: FileList) => void) {
  return {
    onDragEnter: (event: DragEvent) => event.preventDefault(),
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      onFiles(event.dataTransfer.files);
    },
  };
}
