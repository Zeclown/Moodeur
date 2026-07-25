"use strict";

let failures = 0;

function item(id, kind, x, y, z = 0) {
  return { id, kind, x, y, width: 20, height: 20, z };
}

function assertOrder(name, items, selectedIds, expected) {
  const actual = MoodeurPresentationOrder.imageIds(items, selectedIds);
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${name}: expected ${expected.join(", ")}, got ${actual.join(", ")}`);
}

assertOrder(
  "ignores text and audio",
  [item("note", "text", 0, 0), item("song", "audio", 20, 0)],
  [],
  [],
);

const route = [
  item("top-left", "image", 0, 0),
  item("near", "image", 100, 0),
  item("nearest-next", "image", 125, 0),
  item("lower", "image", 0, 100),
];

assertOrder(
  "starts top-left and follows nearest neighbors",
  route,
  [],
  ["top-left", "near", "nearest-next", "lower"],
);

assertOrder(
  "one selected picture seeds the full route",
  route,
  ["nearest-next"],
  ["nearest-next", "near", "top-left", "lower"],
);

assertOrder(
  "two selected pictures limit the route",
  route,
  ["near", "lower"],
  ["near", "lower"],
);

assertOrder(
  "selected text does not affect the picture route",
  [item("note", "text", -100, -100), ...route],
  ["note"],
  ["top-left", "near", "nearest-next", "lower"],
);

assertOrder(
  "equal distances use spatial tie breaking",
  [
    item("start", "image", 0, 0),
    item("right", "image", 20, 20),
    item("left", "image", -20, 20),
  ],
  ["start"],
  ["start", "left", "right"],
);

assertOrder(
  "equal positions use layer then id",
  [
    item("start", "image", 0, 0),
    item("b", "image", 100, 100, 2),
    item("c", "image", 100, 100, 1),
    item("a", "image", 100, 100, 1),
  ],
  ["start"],
  ["start", "a", "c", "b"],
);

if (failures) {
  throw new Error(`${failures} presentation-order test${failures === 1 ? "" : "s"} failed`);
}

console.log("Presentation ordering tests passed.");
