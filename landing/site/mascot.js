// The mascot in three poses, drawn on the emblem's own 64 grid
// (public/brand/delegatus-mark.svg): the same body, belly, hair and glasses,
// with wings, feet and eyes added per pose. Each <span data-mascot="pose">
// in the page is replaced by its inline SVG, so parts can move on their own.
(function () {
  "use strict";

  const RED = "#E0392B";
  const RED_DEEP = "#B52A21";
  const BELLY = "#F7DCC6";
  const HAIR = "#7B6D68";
  const HAIR_LIGHT = "#ABA09B";
  const LENS = "#FBEBDD";
  const INK = "#231B1C";
  const FOOT = "#F59B2F";

  const BODY = "M32 7C18 7 10 20 10 36C10 51 19 60 32 60C45 60 54 51 54 36C54 20 46 7 32 7Z";
  const HAIR_PATH =
    "M12 23C10 14 15 7 23 6C27 3 33 2 37 4C44 2 51 2 58 1C56 5 54 8 52 10C56 13 58 17 57 22C53 19 49 18 46 19C43 22 38 22 35 20C30 18 24 19 20 22C17 24 14 24 12 23Z";
  const HAIR_STREAK = "M18 16Q34.4 12.1 50 6Q33.3 8.7 18 16Z";

  let serial = 0;

  function eyes(pose) {
    if (pose === "giggling") {
      return `<g class="m-eyes" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round">
        <path d="M17.6 32.4Q21 28.2 24.4 32.4"/><path d="M39.6 32.4Q43 28.2 46.4 32.4"/></g>`;
    }
    const dx = pose === "perched" ? 1.6 : 0;
    const dy = pose === "perched" ? 1.4 : 0;
    return `<g class="m-eyes" fill="${INK}"><circle cx="${22 + dx}" cy="${31 + dy}" r="2.3"/><circle cx="${42 + dx}" cy="${31 + dy}" r="2.3"/></g>`;
  }

  function wings(pose) {
    if (pose === "catching") {
      return `<path class="m-wing m-wing-l" fill="${RED_DEEP}" d="M14 34C7 29 2 21-1 13C-5 21-4 32 2 39C6 43 10 44 14 43Z"/>
        <path class="m-wing m-wing-r" fill="${RED_DEEP}" d="M50 34C57 29 62 21 65 13C69 21 68 32 62 39C58 43 54 44 50 43Z"/>`;
    }
    if (pose === "perched") {
      return `<path fill="${RED_DEEP}" d="M11.5 37C7.5 42 7.5 49 12.5 54C13 48 13 42 11.5 37Z"/>
        <path fill="${RED_DEEP}" d="M52.5 37C56.5 42 56.5 49 51.5 54C51 48 51 42 52.5 37Z"/>`;
    }
    return "";
  }

  function frontWing(pose) {
    // Giggling: one wing comes across the mouth area.
    if (pose !== "giggling") return "";
    return `<path class="m-wing-front" fill="${RED_DEEP}" d="M55 37C49 33.5 38 34.5 30.5 41C28.6 42.8 29.6 46.2 32.6 46.4C40 47 48.5 46 55 43.5Z"/>`;
  }

  function feet(pose) {
    if (pose === "perched") {
      return `<g class="m-legs"><path d="M26.5 57.5L25.5 70M37.5 57.5L38.5 70" stroke="${RED_DEEP}" stroke-width="3.2" stroke-linecap="round"/>
        <ellipse cx="24.6" cy="71" rx="4.4" ry="2.2" fill="${FOOT}"/><ellipse cx="39.4" cy="71" rx="4.4" ry="2.2" fill="${FOOT}"/></g>`;
    }
    return `<ellipse cx="25" cy="61.2" rx="5.4" ry="2.6" fill="${FOOT}"/><ellipse cx="39" cy="61.2" rx="5.4" ry="2.6" fill="${FOOT}"/>`;
  }

  function svg(pose) {
    const id = `dlg-m${++serial}`;
    const viewBox = pose === "perched" ? "-6 -2 76 76" : pose === "catching" ? "-8 -2 80 68" : "0 -2 64 66";
    return `<svg class="mascot-svg mascot-${pose}" viewBox="${viewBox}" aria-hidden="true" focusable="false">
  <defs>
    <clipPath id="${id}-b"><path d="${BODY}"/></clipPath>
    <clipPath id="${id}-l"><rect x="13" y="25" width="16" height="11" rx="3"/><rect x="35" y="25" width="16" height="11" rx="3"/></clipPath>
  </defs>
  <g class="m-all">
    ${feet(pose)}
    ${wings(pose)}
    <g class="m-body">
      <path fill="${RED}" d="${BODY}"/>
      <g clip-path="url(#${id}-b)">
        <path fill="${RED_DEEP}" opacity=".4" d="M44 9C58 22 60 48 42 62H62V9Z"/>
        <ellipse cx="32" cy="54" rx="15" ry="11" fill="${BELLY}"/>
      </g>
      <path fill="${HAIR}" d="${HAIR_PATH}"/>
      <path fill="${HAIR_LIGHT}" d="${HAIR_STREAK}"/>
      <g class="m-glasses">
        <g fill="${LENS}" stroke="${INK}" stroke-width="3.6" stroke-linejoin="round">
          <rect x="13" y="25" width="16" height="11" rx="3"/><rect x="35" y="25" width="16" height="11" rx="3"/>
        </g>
        <path d="M29 29.5H35" stroke="${INK}" stroke-width="3.2"/>
        ${eyes(pose)}
        <g clip-path="url(#${id}-l)"><path class="m-glint" d="M6 38L13 22H16.5L9.5 38Z" fill="#fff" opacity="0"/></g>
      </g>
      ${frontWing(pose)}
    </g>
  </g>
</svg>`;
  }

  function mount(root) {
    for (const node of root.querySelectorAll("[data-mascot]")) {
      if (node.firstElementChild) continue;
      node.innerHTML = svg(node.dataset.mascot);
    }
  }

  window.DLG = window.DLG || {};
  window.DLG.mascot = { svg, mount };
})();
