"use strict";

((root) => {
  function center(item) {
    return {
      x: item.x + item.width / 2,
      y: item.y + item.height / 2,
    };
  }

  function spatialCompare(left, right) {
    const leftCenter = center(left);
    const rightCenter = center(right);
    return leftCenter.y - rightCenter.y
      || leftCenter.x - rightCenter.x
      || left.z - right.z
      || left.id.localeCompare(right.id);
  }

  function distanceSquared(left, right) {
    const leftCenter = center(left);
    const rightCenter = center(right);
    const x = leftCenter.x - rightCenter.x;
    const y = leftCenter.y - rightCenter.y;
    return x * x + y * y;
  }

  function nearestNeighborIds(items, preferredStartId = null) {
    if (!items.length) return [];
    const remaining = [...items];
    let startIndex = preferredStartId
      ? remaining.findIndex((item) => item.id === preferredStartId)
      : -1;
    if (startIndex < 0) {
      startIndex = remaining.reduce(
        (best, item, index) => spatialCompare(item, remaining[best]) < 0 ? index : best,
        0,
      );
    }

    const ordered = [remaining.splice(startIndex, 1)[0]];
    while (remaining.length) {
      const current = ordered.at(-1);
      let nearestIndex = 0;
      let nearestDistance = distanceSquared(current, remaining[0]);
      for (let index = 1; index < remaining.length; index += 1) {
        const candidateDistance = distanceSquared(current, remaining[index]);
        if (candidateDistance < nearestDistance
          || candidateDistance === nearestDistance
            && spatialCompare(remaining[index], remaining[nearestIndex]) < 0) {
          nearestIndex = index;
          nearestDistance = candidateDistance;
        }
      }
      ordered.push(remaining.splice(nearestIndex, 1)[0]);
    }
    return ordered.map((item) => item.id);
  }

  function imageIds(items, selectedIds = []) {
    const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
    const images = items.filter((item) => item.kind === "image");
    const selectedImages = images.filter((item) => selected.has(item.id));
    const candidates = selectedImages.length >= 2 ? selectedImages : images;
    const preferredStartId = selectedImages.length === 1 ? selectedImages[0].id : null;
    return nearestNeighborIds(candidates, preferredStartId);
  }

  root.MoodeurPresentationOrder = Object.freeze({ imageIds });
})(globalThis);
