(function () {
  const field = (item, name) => item[name] ?? item[name[0].toUpperCase() + name.slice(1)];
  const text = (item, name) => String(field(item, name) || "").trim();
  const productId = (groupId) => ("group-" + groupId).replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase();

  function groupItems(items) {
    const groups = new Map();
    items.forEach((item) => {
      const key = text(item, "productGroupId");
      if (!key) return;
      const name = text(item, "productGroupName");
      const flavor = text(item, "flavor");
      const size = text(item, "quantity");
      if (!text(item, "id") || !name || !flavor || !size) {
        throw new Error("Catalog variant is missing its ID, group name, flavour or pack size: " + key);
      }
      if (!groups.has(key)) groups.set(key, { key, name, variants: [] });
      const group = groups.get(key);
      if (group.name !== name || group.variants.some((other) =>
        text(other, "flavor") === flavor && text(other, "quantity") === size)) {
        throw new Error("Catalog group contains inconsistent names or duplicate variants: " + key);
      }
      group.variants.push(item);
    });
    return Array.from(groups.values());
  }

  function select(variants, flavor, size) {
    return variants.find((item) => text(item, "flavor") === flavor && text(item, "quantity") === size) || null;
  }

  function initial(variants) {
    return variants.find((item) => field(item, "inStock") !== false && text(item, "imageUri"))
      || variants.find((item) => field(item, "inStock") !== false) || variants[0];
  }

  function cartName(item) {
    return [text(item, "productGroupName"), text(item, "flavor"), text(item, "quantity")].join(" - ");
  }

  function images(item) {
    return [...new Set([text(item, "imageUri"), ...(field(item, "imageUris") || [])].filter(Boolean))];
  }

  function mountSelectors(host, variants, selected, onChange) {
    host.replaceChildren();
    [["flavor", "Flavour"], ["quantity", "Pack size"]].forEach(([key, title]) => {
      const label = document.createElement("label");
      label.textContent = title;
      const select = document.createElement("select");
      select.dataset.variantOption = key;
      [...new Set(variants.map((item) => text(item, key)))].forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
      });
      select.value = text(selected, key);
      select.addEventListener("change", () => onChange(
        host.querySelector('[data-variant-option="flavor"]').value,
        host.querySelector('[data-variant-option="quantity"]').value
      ));
      label.appendChild(select);
      host.appendChild(label);
    });
  }

  function renderGallery(image, urls, label) {
    const host = image.parentElement;
    host.setAttribute("data-catalog-gallery", "");
    host.setAttribute("role", "group");
    host.setAttribute("aria-label", label + " images");
    host.querySelectorAll("[data-gallery-controls], [data-gallery-message]").forEach((node) => node.remove());
    const message = document.createElement("p");
    message.dataset.galleryMessage = "";
    message.className = "catalog-image-message";
    message.setAttribute("role", "status");
    message.textContent = "Image not yet available for this pack.";
    message.hidden = urls.length > 0;
    host.appendChild(message);
    let index = 0;
    const controls = document.createElement("div");
    controls.dataset.galleryControls = "";
    controls.className = "catalog-gallery-controls";
    const status = document.createElement("span");
    status.setAttribute("aria-live", "polite");
    function show(next) {
      index = (next + urls.length) % urls.length;
      image.hidden = false;
      message.hidden = true;
      image.alt = label + " - image " + (index + 1) + " of " + urls.length;
      image.onerror = function () {
        console.error("Unable to load catalog image:", urls[index]);
        image.hidden = true;
        message.textContent = "This product image could not be loaded.";
        message.hidden = false;
      };
      image.src = urls[index];
      status.textContent = (index + 1) + " / " + urls.length;
    }
    if (urls.length) show(0);
    else {
      image.onerror = null;
      image.hidden = true;
      image.removeAttribute("src");
    }
    [["Previous image", -1, "<"], ["Next image", 1, ">"]].forEach(([title, step, symbol]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-label", title);
      button.textContent = symbol;
      button.addEventListener("click", () => show(index + step));
      controls.appendChild(button);
    });
    controls.insertBefore(status, controls.lastChild);
    controls.hidden = urls.length < 2;
    host.appendChild(controls);
    host.onkeydown = function (event) {
      if (urls.length < 2 || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      show(index + (event.key === "ArrowRight" ? 1 : -1));
    };
  }

  const api = { field, text, productId, groupItems, select, initial, cartName, images, mountSelectors, renderGallery };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.SpicebloomsVariants = api;
})();
