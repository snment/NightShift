import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BotAvatar,
  InitialsAvatar,
  MausAvatar,
  resolveBotAvatarOutcome,
  type BotAvatarProps,
  type MausAvatarProps,
} from "./Avatar";
import { MASCOT_BODIES } from "../../shared/mascot-bodies";

const render = (props: Partial<MausAvatarProps>) =>
  renderToStaticMarkup(createElement(MausAvatar, { color: "green", animated: false, ...props }));

const renderBot = (bot: Partial<BotAvatarProps["bot"]>) =>
  renderToStaticMarkup(
    createElement(BotAvatar, { bot: { color: "green", ...bot }, animated: false }),
  );

// NightShift Phase 0 hides the upstream mascot (Avatar.tsx SHOW_UPSTREAM_MASCOT): every body is a neutral disc.
describe("MausAvatar body", () => {
  it("draws a neutral disc, not the cursor, when no body is given", () => {
    const markup = render({});
    expect(markup).not.toContain(MASCOT_BODIES.cursor.fit);
    expect(markup).not.toContain("<svg");
    expect(markup).toContain("rounded-full");
  });

  it("draws a neutral disc, not the body it is given", () => {
    const markup = render({ bodyId: "star" });
    expect(markup).not.toContain(MASCOT_BODIES.star.fit);
    expect(markup).not.toContain("<svg");
  });

  it("draws a neutral disc for an unknown body", () => {
    // SAFETY: "hexagram" is deliberately not a MascotBodyId, to exercise the runtime fallback for persisted or streamed
    // data.
    const markup = render({ bodyId: "hexagram" as MausAvatarProps["bodyId"] });
    expect(markup).not.toContain(MASCOT_BODIES.cursor.fit);
    expect(markup).toContain("rounded-full");
  });

  it("paints the disc with the per-bot gradient, never a flat black fill, and shows the label's initial", () => {
    const markup = render({ bodyId: "circle", label: "ada" });
    expect(markup).not.toContain('fill="#000000"');
    expect(markup).not.toContain("{{GRADIENT}}");
    expect(markup).toContain("linear-gradient(");
    expect(markup).toContain(">A</span>");
  });
});

describe("mascot facial feature colors", () => {
  it.each(["white", "black"] as const)("paints no %s mascot face on any body type: the neutral disc has none", (mascotFaceColor) => {
    const ink = mascotFaceColor === "white" ? "#ffffff" : "#000000";
    for (const mascotBody of ["cursor", "star", "pumpkin", "vampire"] as const) {
      for (const color of ["green", "chrome"] as const) {
        const markup = renderBot({ name: "Ada", color, mascotBody, mascotFaceColor });
        expect(markup).not.toContain(`stroke="${ink}"`);
        expect(markup).not.toContain("<svg");
        expect(markup).toContain(">A</span>");
      }
    }
  });

  it("draws no face inks when an override is reset or comes from an older profile", () => {
    expect(renderBot({ color: "chrome", mascotFaceColor: null })).not.toContain("<svg");
    expect(renderBot({ mascotBody: "ghost" })).not.toContain("<svg");
    expect(renderBot({})).toContain("linear-gradient(");
  });

  it("does not paint features over an uploaded image", () => {
    const markup = renderBot({ mascotFaceColor: "black", avatarUrl: "/api/attachments/photo.png", avatarCrop: "circle" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<svg");
  });
});

describe("BotAvatar's two avatar outcomes", () => {
  it("zooms and positions a custom image inside its crop", () => {
    const markup = renderBot({
      avatarUrl: "/api/attachments/cat.webp",
      avatarCrop: "circle",
      avatarZoom: 2,
      avatarFocusX: 0.25,
      avatarFocusY: 0.75,
    });
    expect(markup).toContain("scale(2)");
    expect(markup).toContain("25% 75%");
    expect(markup).toContain("border-radius:50%");
  });

  it("renders a flat cropped image for circle/rounded/square, with no mascot at all", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<svg");
  });

  it("shows the image as it is, with no mascot face painted on it", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "square" });
    expect(markup).toContain("border-radius:0");
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<image");
    expect(markup).not.toContain("radialGradient");
  });

  it("renders the neutral disc in the mascot's place when the crop is mascot, image or not", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "mascot" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("linear-gradient(");
  });

  it("falls back to the neutral disc when a flat crop has no valid image", () => {
    const markup = renderBot({ avatarUrl: undefined, avatarCrop: "circle" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("linear-gradient(");
  });
});

describe("theme hooks on faces", () => {
  it("marks a bot's picture, its gradient mascot and its carved mascot, and leaves a decorative mascot unmarked", () => {
    expect(renderBot({ avatarUrl: "/api/attachments/a.png", avatarCrop: "circle" })).toMatch(/<span data-avatar="picture" data-avatar-kind="bot"/);
    expect(renderBot({})).toMatch(/<span data-avatar="mascot" data-avatar-kind="bot"/);
    expect(renderBot({ mascotBody: "ghost" })).toMatch(/<span data-avatar="mascot" data-avatar-kind="bot"/);
    expect(render({})).not.toContain("data-avatar");
  });

  it("marks the person's picture and their initials", () => {
    expect(renderToStaticMarkup(createElement(InitialsAvatar, { initials: "AL", avatarUrl: "/api/attachments/me.png" }))).toMatch(/<img data-avatar="picture" data-avatar-kind="person"/);
    expect(renderToStaticMarkup(createElement(InitialsAvatar, { initials: "AL" }))).toMatch(/<div data-avatar="initials" data-avatar-kind="person"/);
  });
});

describe("resolveBotAvatarOutcome", () => {
  // imageFailed is set by the <img>'s onError, which renderToStaticMarkup never fires, so the decision is a pure
  // function.
  it("falls back to the gradient mascot for an image that failed to load", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "circle", hasUrl: true, imageFailed: true }),
    ).toBe("gradientMascot");
  });

  it("renders a good flat image flat", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "rounded", hasUrl: true, imageFailed: false }),
    ).toBe("flatImage");
  });

  it("keeps the mascot crop on the gradient mascot even with a loaded image", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "mascot", hasUrl: true, imageFailed: false }),
    ).toBe("gradientMascot");
  });

  it("falls back to the gradient mascot when there is no image at all", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "square", hasUrl: false, imageFailed: false }),
    ).toBe("gradientMascot");
  });
});
