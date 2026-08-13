import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ImageAnnotationEditor } from "./ImageAnnotationEditor";

describe("ImageAnnotationEditor", () => {
  it("explains that markup is burned into any image the agent sees", () => {
    const file = new File([new Uint8Array([1])], "clients.png", { type: "image/png" });
    const markup = renderToStaticMarkup(
      <ImageAnnotationEditor
        image={{
          type: "image",
          id: "img-1",
          name: "clients.png",
          mimeType: "image/png",
          sizeBytes: 1,
          previewUrl: "blob:preview",
          file,
        }}
        onCancel={vi.fn()}
        onApply={vi.fn()}
      />,
    );

    expect(markup).toContain("Mark up image");
    expect(markup).toContain("Markup is burned into the image the agent sees");
    expect(markup).toContain("Arrow");
    expect(markup).toContain("Number");
    expect(markup).toContain("Crop");
  });
});
