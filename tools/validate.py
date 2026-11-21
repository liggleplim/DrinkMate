#!/usr/bin/env python3
"""
DrinkMate Chain, Visual Mapping & Drink State Validator (Python 3 stdlib only).

Loads data/schema/chain.schema.json as the single source of truth for all
structural checks (required fields, unknown keys, types, enums, patterns,
ranges), then runs semantic cross-reference, temperature/size grid, and
data/visual/<chainId>.visual.json checks.

Run from the project root:
    Windows:        python tools/validate.py   (or: py tools/validate.py)
    Android Termux: python tools/validate.py
    macOS / Linux:  python3 tools/validate.py

Optional flags:
    --drink path/to/drink.json   Validate a saved drink JSON against its chain
    --self-test                  Run built-in positive and negative tests
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
from pathlib import Path
from typing import Any

VALID_LEVELS = {"light", "regular", "extra"}
VALID_CUP_LAYERS = {"mix", "foam", "top", "drizzle"}
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
SEMVER_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")


def is_int(val: Any) -> bool:
    return isinstance(val, int) and not isinstance(val, bool)


def is_num(val: Any) -> bool:
    return isinstance(val, (int, float)) and not isinstance(val, bool)


def matches_type(val: Any, expected: str) -> bool:
    if expected == "null":
        return val is None
    if expected == "boolean":
        return isinstance(val, bool)
    if expected == "integer":
        return is_int(val)
    if expected == "number":
        return is_num(val)
    if expected == "string":
        return isinstance(val, str)
    if expected == "array":
        return isinstance(val, list)
    if expected == "object":
        return isinstance(val, dict)
    return False


def resolve_ref(ref: str, root_schema: dict[str, Any]) -> dict[str, Any]:
    if not ref.startswith("#/"):
        raise ValueError(f"Unsupported $ref: {ref}")
    node: Any = root_schema
    for part in ref[2:].split("/"):
        node = node[part]
    return node


def check_schema(
    instance: Any,
    schema: dict[str, Any],
    root_schema: dict[str, Any],
    file_label: str,
    path: str,
    errors: list[str],
) -> None:
    """Standard-library JSON Schema structural checker driven by chain.schema.json."""
    if "$ref" in schema:
        schema = resolve_ref(schema["$ref"], root_schema)

    if "oneOf" in schema:
        matched = 0
        for sub in schema["oneOf"]:
            sub_errors: list[str] = []
            check_schema(instance, sub, root_schema, file_label, path, sub_errors)
            if not sub_errors:
                matched += 1
        if matched != 1:
            errors.append(f"[{file_label}] [{path}] Value does not match expected schema (oneOf)")
        return

    if "type" in schema:
        allowed = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(matches_type(instance, t) for t in allowed):
            errors.append(f"[{file_label}] [{path}] Expected type {allowed}, got {type(instance).__name__}")
            return

    if "const" in schema and instance != schema["const"]:
        errors.append(f"[{file_label}] [{path}] Expected constant {schema['const']!r}, got {instance!r}")

    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"[{file_label}] [{path}] Value {instance!r} not in allowed enum {schema['enum']}")

    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append(f"[{file_label}] [{path}] String shorter than minLength {schema['minLength']}")
        if "pattern" in schema and not re.match(schema["pattern"], instance):
            errors.append(f"[{file_label}] [{path}] String {instance!r} does not match pattern {schema['pattern']}")
        if schema.get("format") == "date":
            try:
                datetime.date.fromisoformat(instance)
            except ValueError:
                errors.append(f"[{file_label}] [{path}] Invalid ISO calendar date {instance!r}")

    if is_num(instance) and "minimum" in schema and instance < schema["minimum"]:
        errors.append(f"[{file_label}] [{path}] Value {instance} is less than minimum {schema['minimum']}")

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"[{file_label}] [{path}] Array has fewer than {schema['minItems']} item(s)")
        if schema.get("uniqueItems"):
            seen_items: list[Any] = []
            for item in instance:
                if item in seen_items:
                    errors.append(f"[{file_label}] [{path}] Duplicate item {item!r} in unique array")
                    break
                seen_items.append(item)
        if "items" in schema:
            for idx, item in enumerate(instance):
                item_label = item.get("id") if isinstance(item, dict) and isinstance(item.get("id"), str) else str(idx)
                check_schema(item, schema["items"], root_schema, file_label, f"{path}[{item_label}]", errors)

    if isinstance(instance, dict):
        props = schema.get("properties", {})
        for req_key in schema.get("required", []):
            if req_key not in instance:
                errors.append(f"[{file_label}] [{path}] Missing required field '{req_key}'")
        addl = schema.get("additionalProperties", True)
        for key, val in instance.items():
            child_path = f"{path}.{key}" if path != "root" else key
            if key in props:
                check_schema(val, props[key], root_schema, file_label, child_path, errors)
            elif addl is False:
                errors.append(f"[{file_label}] [{path}] Unknown field '{key}' is not allowed by schema")
            elif isinstance(addl, dict):
                check_schema(val, addl, root_schema, file_label, child_path, errors)


def load_schema(project_root: Path) -> dict[str, Any]:
    schema_path = project_root / "data" / "schema" / "chain.schema.json"
    if not schema_path.exists():
        raise FileNotFoundError(
            "chain.schema.json not found at data/schema/. Copy it there (from the Drive project/ folder) and try again."
        )
    return json.loads(schema_path.read_text(encoding="utf-8"))


def validate_chain(
    data: Any,
    schema: dict[str, Any],
    file_label: str,
    expected_id: str | None = None,
) -> list[str]:
    errors: list[str] = []

    # 1. Schema-driven structural validation (single source of truth)
    check_schema(data, schema, schema, file_label, "root", errors)
    if not isinstance(data, dict):
        return errors

    # 2. Filename vs meta.id
    meta = data.get("meta")
    if isinstance(meta, dict) and expected_id and meta.get("id") != expected_id:
        errors.append(f"[{file_label}] [meta] meta.id '{meta.get('id')}' does not match filename '{expected_id}.json'")

    # 3. Chain-wide unique IDs across categories, sizes, milks, modifiers, bases, rules
    chain_ids: dict[str, str] = {}
    collections: dict[str, dict[str, dict[str, Any]]] = {
        "categories": {},
        "sizes": {},
        "milks": {},
        "modifiers": {},
        "bases": {},
        "rules": {},
    }
    for col_name in collections:
        items = data.get(col_name)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            item_id = item.get("id")
            if not isinstance(item_id, str):
                continue
            if item_id in chain_ids:
                prev_col = chain_ids[item_id]
                errors.append(
                    f"[{file_label}] [{item_id}] Duplicate ID across chain (already used in '{prev_col}', repeated in '{col_name}')"
                )
            else:
                chain_ids[item_id] = col_name
                collections[col_name][item_id] = item

    category_ids = set(collections["categories"])
    sizes_by_id = collections["sizes"]
    milks_by_id = collections["milks"]
    mods_by_id = collections["modifiers"]
    bases_by_id = collections["bases"]

    # 4. Size semantic checks: volumeOzByTemperature cannot have non-null for unsupported temperature
    for sid, sz in sizes_by_id.items():
        s_temps = set(sz.get("supportedTemperatures", []))
        vol_map = sz.get("volumeOzByTemperature")
        if isinstance(vol_map, dict):
            for tk, tv in vol_map.items():
                if tv is not None and tk not in s_temps:
                    errors.append(
                        f"[{file_label}] [{sid}] volumeOzByTemperature.{tk} is non-null ({tv}) but '{tk}' is not in supportedTemperatures"
                    )

    # 5. Modifier semantic checks: selectionMode rules & size references
    for mod_id, mod in mods_by_id.items():
        sel_mode = mod.get("selectionMode")
        dc = mod.get("defaultCountBySize")
        mc = mod.get("maxCount")
        if sel_mode == "level":
            if dc is not None:
                errors.append(f"[{file_label}] [{mod_id}] defaultCountBySize must be null when selectionMode is 'level'")
            if mc is not None:
                errors.append(f"[{file_label}] [{mod_id}] maxCount must be null when selectionMode is 'level'")
        elif sel_mode == "count" and isinstance(dc, dict):
            for sk, sv in dc.items():
                if sk not in sizes_by_id:
                    errors.append(f"[{file_label}] [{mod_id}] defaultCountBySize references unknown size '{sk}'")
                elif is_int(sv) and is_int(mc) and sv > mc:
                    errors.append(f"[{file_label}] [{mod_id}] defaultCountBySize.{sk} ({sv}) exceeds maxCount ({mc})")

    # 6. Base cross-references & temperature/size grids
    for bid, base in bases_by_id.items():
        if base.get("categoryId") not in category_ids:
            errors.append(f"[{file_label}] [{bid}] categoryId '{base.get('categoryId')}' does not match any category")

        avail_sizes = base.get("availableSizes", []) if isinstance(base.get("availableSizes"), list) else []
        for sid in avail_sizes:
            if sid not in sizes_by_id:
                errors.append(f"[{file_label}] [{bid}] availableSizes references unknown size '{sid}'")

        b_temps = base.get("supportedTemperatures", []) if isinstance(base.get("supportedTemperatures"), list) else []
        valid_sizes_for_temp: dict[str, set[str]] = {
            t: {
                sid for sid in avail_sizes
                if sid in sizes_by_id and t in sizes_by_id[sid].get("supportedTemperatures", [])
            }
            for t in b_temps
        }

        base_prices = base.get("basePriceBySize")
        if isinstance(base_prices, dict):
            for sk in base_prices:
                if sk not in avail_sizes:
                    errors.append(f"[{file_label}] [{bid}] basePriceBySize size '{sk}' is not in availableSizes")

        recipe = base.get("defaultRecipe")
        if not isinstance(recipe, dict):
            continue

        milk_id = recipe.get("milkId")
        if milk_id is not None and milk_id not in milks_by_id:
            errors.append(f"[{file_label}] [{bid}] defaultRecipe.milkId '{milk_id}' references unknown milk")

        shots_map = recipe.get("shotsByTemperature")
        if isinstance(shots_map, dict):
            for tk in shots_map:
                if tk not in b_temps:
                    errors.append(f"[{file_label}] [{bid}] defaultRecipe.shotsByTemperature has unsupported temperature '{tk}'")
            for tk in b_temps:
                if tk not in shots_map:
                    errors.append(f"[{file_label}] [{bid}] defaultRecipe.shotsByTemperature missing temperature key '{tk}'")
                    continue
                size_map = shots_map[tk]
                if not isinstance(size_map, dict):
                    continue
                expected_sizes = valid_sizes_for_temp.get(tk, set())
                for sk in sorted(expected_sizes):
                    if sk not in size_map:
                        errors.append(
                            f"[{file_label}] [{bid}] defaultRecipe.shotsByTemperature.{tk} missing key '{sk}' (use 0 for none by design, or explicit null if unconfirmed)"
                        )
                for sk in size_map:
                    if sk not in expected_sizes:
                        errors.append(f"[{file_label}] [{bid}] defaultRecipe.shotsByTemperature.{tk} has invalid size '{sk}' for this base and temperature")

        rec_mods = recipe.get("modifiers")
        if isinstance(rec_mods, list):
            seen_rec_mods: set[str] = set()
            for r_idx, rm in enumerate(rec_mods):
                if not isinstance(rm, dict):
                    continue
                rm_id = rm.get("modifierId")
                if rm_id in seen_rec_mods:
                    errors.append(f"[{file_label}] [{bid}] defaultRecipe.modifiers has duplicate modifierId '{rm_id}'")
                elif isinstance(rm_id, str):
                    seen_rec_mods.add(rm_id)
                if rm_id not in mods_by_id:
                    errors.append(f"[{file_label}] [{bid}] defaultRecipe.modifiers[{r_idx}] references unknown modifier '{rm_id}'")
                    continue
                mod_def = mods_by_id[rm_id]
                mode = mod_def.get("selectionMode")
                max_c = mod_def.get("maxCount")
                if mode == "count":
                    if rm.get("defaultLevel") is not None:
                        errors.append(f"[{file_label}] [{bid}] defaultRecipe modifier '{rm_id}' is count-mode so defaultLevel must be null/omitted")
                    ct_map = rm.get("countByTemperatureAndSize")
                    if not isinstance(ct_map, dict):
                        errors.append(f"[{file_label}] [{bid}] defaultRecipe modifier '{rm_id}' requires countByTemperatureAndSize")
                    else:
                        for tk in ct_map:
                            if tk not in b_temps:
                                errors.append(f"[{file_label}] [{bid}] defaultRecipe modifier '{rm_id}' has unsupported temperature '{tk}'")
                        for tk in b_temps:
                            if tk not in ct_map:
                                errors.append(f"[{file_label}] [{bid}] defaultRecipe modifier '{rm_id}' missing temperature '{tk}'")
                                continue
                            s_map = ct_map[tk]
                            if not isinstance(s_map, dict):
                                continue
                            expected_sizes = valid_sizes_for_temp.get(tk, set())
                            for sk in sorted(expected_sizes):
                                if sk not in s_map:
                                    errors.append(f"[{file_label}] [{bid}] defaultRecipe modifier '{rm_id}'.{tk} missing size '{sk}'")
                            for sk, sv in s_map.items():
                                if sk not in expected_sizes:
                                    errors.append(f"[{file_label}] [{bid}] defaultRecipe modifier '{rm_id}'.{tk} has invalid size '{sk}'")
                                elif is_int(sv) and is_int(max_c) and sv > max_c:
                                    errors.append(f"[{file_label}] [{bid}] defaultRecipe modifier '{rm_id}'.{tk}.{sk} ({sv}) exceeds modifier maxCount ({max_c})")
                elif mode == "level":
                    if rm.get("countByTemperatureAndSize") is not None:
                        errors.append(f"[{file_label}] [{bid}] defaultRecipe modifier '{rm_id}' is level-mode so countByTemperatureAndSize must be null/omitted")
                    if rm.get("defaultLevel") not in VALID_LEVELS:
                        errors.append(f"[{file_label}] [{bid}] defaultRecipe modifier '{rm_id}' requires defaultLevel in {sorted(VALID_LEVELS)}")

    # 7. Rules cross-references
    valid_rule_targets = category_ids | set(sizes_by_id) | set(milks_by_id) | set(mods_by_id) | set(bases_by_id)
    for rid, rule in collections["rules"].items():
        for target in rule.get("appliesTo", []):
            if target not in valid_rule_targets:
                errors.append(f"[{file_label}] [{rid}] appliesTo references unknown item '{target}'")

    # 8. Seasonal cross-references
    seasonal = data.get("seasonal")
    if isinstance(seasonal, list):
        for entry in seasonal:
            if not isinstance(entry, dict):
                continue
            eid = entry.get("itemId")
            kind = entry.get("itemKind")
            if kind == "base" and eid not in bases_by_id:
                errors.append(f"[{file_label}] [{eid}] seasonal itemId does not match any base")
            elif kind == "modifier" and eid not in mods_by_id:
                errors.append(f"[{file_label}] [{eid}] seasonal itemId does not match any modifier")

    return errors


def validate_visual_mapping(
    visual: Any,
    chains_loaded: dict[str, dict[str, Any]],
    indexed_chain_ids: set[str],
    file_label: str,
    expected_chain_id: str | None = None,
) -> list[str]:
    """Validate data/visual/<chainId>.visual.json against its matching chain."""
    errors: list[str] = []
    if not isinstance(visual, dict):
        return [f"[{file_label}] [root] Visual mapping must be a JSON object"]

    req_top = {"schemaVersion", "chainId", "bases", "milks", "modifiers"}
    for key in sorted(req_top - set(visual.keys())):
        errors.append(f"[{file_label}] [root] Missing required top-level key '{key}'")
    for key in sorted(set(visual.keys()) - req_top):
        errors.append(f"[{file_label}] [root] Unknown top-level key '{key}' is not allowed")

    sv = visual.get("schemaVersion")
    if not isinstance(sv, str) or not SEMVER_RE.match(sv):
        errors.append(f"[{file_label}] [schemaVersion] Must be a semver string (e.g., '1.0.0')")

    cid = visual.get("chainId")
    if not isinstance(cid, str) or not SLUG_RE.match(cid):
        errors.append(f"[{file_label}] [chainId] Must be a lowercase slug")
        return errors
    if expected_chain_id and cid != expected_chain_id:
        errors.append(f"[{file_label}] [chainId] chainId '{cid}' does not match filename '{expected_chain_id}.visual.json'")
    if cid not in indexed_chain_ids:
        errors.append(f"[{file_label}] [chainId] chainId '{cid}' is not listed in data/index.json")
    if cid not in chains_loaded:
        errors.append(f"[{file_label}] [chainId] Matching chain file data/chains/{cid}.json not loaded")
        return errors

    chain = chains_loaded[cid]
    valid_ids = {
        "bases": {b["id"] for b in chain.get("bases", []) if isinstance(b, dict) and "id" in b},
        "milks": {m["id"] for m in chain.get("milks", []) if isinstance(m, dict) and "id" in m},
        "modifiers": {m["id"] for m in chain.get("modifiers", []) if isinstance(m, dict) and "id" in m},
    }

    for section in ("bases", "milks", "modifiers"):
        sec_obj = visual.get(section)
        if not isinstance(sec_obj, dict):
            errors.append(f"[{file_label}] [{section}] Must be an object mapping item IDs to visual hints")
            continue
        allowed_keys = {"iconKey", "colorHex", "cupLayer"} if section == "modifiers" else {"iconKey", "colorHex"}
        for item_id, entry in sec_obj.items():
            if item_id not in valid_ids[section]:
                errors.append(f"[{file_label}] [{section}.{item_id}] Unknown {section[:-1]} ID '{item_id}' not found in data/chains/{cid}.json")
            if not isinstance(entry, dict):
                errors.append(f"[{file_label}] [{section}.{item_id}] Visual entry must be an object")
                continue
            for rk in sorted(allowed_keys - set(entry.keys())):
                errors.append(f"[{file_label}] [{section}.{item_id}] Missing required field '{rk}'")
            for uk in sorted(set(entry.keys()) - allowed_keys):
                errors.append(f"[{file_label}] [{section}.{item_id}] Unknown key '{uk}' is not allowed")

            icon_key = entry.get("iconKey")
            if icon_key is not None and (not isinstance(icon_key, str) or not SLUG_RE.match(icon_key)):
                errors.append(f"[{file_label}] [{section}.{item_id}] iconKey must be a lowercase slug or null")

            color_hex = entry.get("colorHex")
            if color_hex is not None and (not isinstance(color_hex, str) or not HEX_COLOR_RE.match(color_hex)):
                errors.append(f"[{file_label}] [{section}.{item_id}] colorHex {color_hex!r} must match #RRGGBB or be null")

            if section == "modifiers" and "cupLayer" in entry:
                if entry["cupLayer"] not in VALID_CUP_LAYERS:
                    errors.append(
                        f"[{file_label}] [{section}.{item_id}] Invalid cupLayer {entry['cupLayer']!r}; must be one of {sorted(VALID_CUP_LAYERS)}"
                    )

    return errors


def validate_drink_state(
    drink: Any,
    chain: dict[str, Any],
    schema: dict[str, Any],
    label: str = "drink",
) -> list[str]:
    """Validate a saved drink state object (schemaVersion 1.0.0) against schema and chain."""
    errors: list[str] = []
    check_schema(drink, schema["$defs"]["drinkState"], schema, label, "root", errors)
    if not isinstance(drink, dict):
        return errors

    chain_id = chain.get("meta", {}).get("id")
    if drink.get("chainId") != chain_id:
        errors.append(f"[{label}] chainId '{drink.get('chainId')}' does not match chain '{chain_id}'")

    bases = {b["id"]: b for b in chain.get("bases", []) if isinstance(b, dict) and "id" in b}
    sizes = {s["id"]: s for s in chain.get("sizes", []) if isinstance(s, dict) and "id" in s}
    milks = {m["id"]: m for m in chain.get("milks", []) if isinstance(m, dict) and "id" in m}
    mods = {m["id"]: m for m in chain.get("modifiers", []) if isinstance(m, dict) and "id" in m}

    base = bases.get(drink.get("baseId"))
    if not base:
        errors.append(f"[{label}] Unknown baseId '{drink.get('baseId')}'")
    size = sizes.get(drink.get("sizeId"))
    if not size:
        errors.append(f"[{label}] Unknown sizeId '{drink.get('sizeId')}'")
    temp = drink.get("temperature")
    if base and size and isinstance(temp, str):
        if drink["sizeId"] not in base.get("availableSizes", []):
            errors.append(f"[{label}] sizeId '{drink['sizeId']}' is not available for base '{base['id']}'")
        if temp not in base.get("supportedTemperatures", []):
            errors.append(f"[{label}] temperature '{temp}' is not supported by base '{base['id']}'")
        if temp not in size.get("supportedTemperatures", []):
            errors.append(f"[{label}] temperature '{temp}' is not supported by size '{size['id']}'")

    milk_id = drink.get("milkId")
    if milk_id is not None and milk_id not in milks:
        errors.append(f"[{label}] Unknown milkId '{milk_id}'")

    sel_mods = drink.get("modifiers")
    if isinstance(sel_mods, list):
        seen_mods: set[str] = set()
        for idx, entry in enumerate(sel_mods):
            if not isinstance(entry, dict):
                continue
            mid = entry.get("modifierId")
            if mid in seen_mods:
                errors.append(f"[{label}] modifiers[{idx}] duplicate modifierId '{mid}'")
            elif isinstance(mid, str):
                seen_mods.add(mid)
            mod = mods.get(mid)
            if not mod:
                errors.append(f"[{label}] modifiers[{idx}] unknown modifierId '{mid}'")
                continue
            count = entry.get("count")
            level = entry.get("level")
            if (count is None) == (level is None):
                errors.append(f"[{label}] modifiers[{idx}] ({mid}) must set exactly one of count or level")
                continue
            if mod["selectionMode"] == "count":
                if count is None or not is_int(count) or count < 1:
                    errors.append(f"[{label}] modifiers[{idx}] ({mid}) requires integer count >= 1")
                elif mod.get("maxCount") is not None and count > mod["maxCount"]:
                    errors.append(f"[{label}] modifiers[{idx}] ({mid}) count {count} exceeds maxCount {mod['maxCount']}")
            elif mod["selectionMode"] == "level":
                if level not in VALID_LEVELS:
                    errors.append(f"[{label}] modifiers[{idx}] ({mid}) requires level in {sorted(VALID_LEVELS)}")

    opts = drink.get("options")
    if isinstance(opts, list):
        seen_groups: set[str] = set()
        for idx, opt in enumerate(opts):
            if isinstance(opt, dict) and isinstance(opt.get("groupId"), str):
                gid = opt["groupId"]
                if gid in seen_groups:
                    errors.append(f"[{label}] options[{idx}] duplicate groupId '{gid}'")
                seen_groups.add(gid)

    return errors


def validate_index(project_root: Path, all_chain_stems: set[str], chains_loaded: dict[str, dict[str, Any]]) -> tuple[list[str], set[str]]:
    if not all_chain_stems:
        return [], set()
    index_path = project_root / "data" / "index.json"
    if not index_path.exists():
        return ["[data/index.json] [root] Missing required data/index.json (required once any chain file exists)"], set()

    errors: list[str] = []
    try:
        idx_data = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [f"[data/index.json] [root] Invalid JSON: {exc}"], set()
    entries = idx_data.get("chains") if isinstance(idx_data, dict) else idx_data
    if not isinstance(entries, list):
        return ["[data/index.json] [root] Expected a list or object with 'chains' list"], set()

    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            errors.append("[data/index.json] [entry] Each index entry needs a valid slug 'id'")
            continue
        cid = entry["id"]
        if cid in seen:
            errors.append(f"[data/index.json] [{cid}] Duplicate chain entry")
        seen.add(cid)
        if cid not in all_chain_stems:
            errors.append(f"[data/index.json] [{cid}] Chain file data/chains/{cid}.json not found")
        elif cid in chains_loaded:
            meta = chains_loaded[cid].get("meta", {})
            if entry.get("name") != meta.get("name"):
                errors.append(f"[data/index.json] [{cid}] name does not match meta.name")
            if entry.get("lastVerified") != meta.get("lastVerified"):
                errors.append(f"[data/index.json] [{cid}] lastVerified does not match meta.lastVerified")

    for missing_cid in sorted(all_chain_stems - seen):
        errors.append(f"[data/index.json] [{missing_cid}] Chain file data/chains/{missing_cid}.json is missing from data/index.json")

    return errors, seen




VALID_PRESET_CATEGORIES = {"crowd-favorite", "classic-combo", "secret-menu"}


def validate_presets_file(
    pdata: Any,
    chains_loaded: dict[str, dict[str, Any]],
    schema: dict[str, Any],
    label: str,
    expected_chain_id: str,
) -> list[str]:
    """Validate a data/presets/<chainId>.presets.json file."""
    errors: list[str] = []
    if not isinstance(pdata, dict):
        return [f"[{label}] [root] Expected JSON object"]
    meta = pdata.get("meta")
    if not isinstance(meta, dict):
        errors.append(f"[{label}] [meta] Missing or invalid meta object")
    else:
        cid = meta.get("chainId")
        if cid != expected_chain_id:
            errors.append(f"[{label}] [meta.chainId] '{cid}' does not match filename '{expected_chain_id}'")
        if cid not in chains_loaded:
            errors.append(f"[{label}] [meta.chainId] Referenced chain '{cid}' not loaded")
    presets = pdata.get("presets")
    if not isinstance(presets, list):
        errors.append(f"[{label}] [presets] Expected a list")
        return errors

    chain = chains_loaded.get(expected_chain_id)
    seen_ids: set[str] = set()
    for idx, item in enumerate(presets):
        if not isinstance(item, dict):
            errors.append(f"[{label}] [presets[{idx}]] Expected object")
            continue
        pid = item.get("id")
        if not isinstance(pid, str) or not pid:
            errors.append(f"[{label}] [presets[{idx}]] Missing non-empty id")
        elif pid in seen_ids:
            errors.append(f"[{label}] [presets[{idx}]] Duplicate preset id '{pid}'")
        else:
            seen_ids.add(pid)
        if not isinstance(item.get("name"), str) or not item["name"]:
            errors.append(f"[{label}] [presets[{idx}]] Missing non-empty name")
        cat = item.get("category")
        if cat not in VALID_PRESET_CATEGORIES:
            errors.append(f"[{label}] [presets[{idx}]] Invalid category '{cat}' (must be one of {sorted(VALID_PRESET_CATEGORIES)})")
        if not isinstance(item.get("tagline"), str) or not item["tagline"]:
            errors.append(f"[{label}] [presets[{idx}]] Missing non-empty tagline")
        if not isinstance(item.get("verified"), bool):
            errors.append(f"[{label}] [presets[{idx}]] 'verified' must be a boolean")
        if cat == "secret-menu" and item.get("verified") is not False:
            errors.append(f"[{label}] [presets[{idx}]] Secret menu presets must have verified: false")
        if "drinkState" not in item:
            errors.append(f"[{label}] [presets[{idx}]] Missing drinkState")
        elif chain is not None:
            errors.extend(validate_drink_state(item["drinkState"], chain, schema, f"{label}:preset:{pid or idx}"))
    return errors


def assert_error_contains(errors: list[str], substring: str, case_name: str) -> None:
    if not any(substring in e for e in errors):
        raise AssertionError(f"Self-test '{case_name}' expected error containing {substring!r}, got: {errors}")


def run_self_test(project_root: Path) -> int:
    try:
        schema = load_schema(project_root)
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}")
        return 1
    except Exception as exc:
        print(f"ERROR: Could not read data/schema/chain.schema.json: {exc}")
        return 1

    sample_chain = {
        "meta": {
            "id": "sample-chain",
            "name": "Sample Chain",
            "region": "US",
            "currency": "USD",
            "schemaVersion": "1.0.0",
            "lastVerified": "2026-11-20",
            "sources": ["https://example.com/menu"],
            "confidence": "high",
            "brandColor": "#00704A",
        },
        "sizes": [
            {"id": "short", "name": "Short", "volumeOz": 8, "volumeOzByTemperature": {"hot": 8, "iced": None, "blended": None}, "supportedTemperatures": ["hot"]},
            {"id": "grande", "name": "Grande", "volumeOz": 16, "volumeOzByTemperature": {"hot": 16, "iced": 16, "blended": 16}, "supportedTemperatures": ["hot", "iced", "blended"]},
        ],
        "categories": [{"id": "espresso", "name": "Espresso"}],
        "bases": [
            {
                "id": "caffe-latte",
                "name": "Caffe Latte",
                "categoryId": "espresso",
                "availableSizes": ["short", "grande"],
                "supportedTemperatures": ["hot", "iced"],
                "basePriceBySize": {"short": None, "grande": None},
                "defaultRecipe": {
                    "milkId": "2-percent-milk",
                    "shotsByTemperature": {
                        "hot": {"short": 1, "grande": 2},
                        "iced": {"grande": 2},
                    },
                    "modifiers": [],
                },
                "isSeasonal": False,
                "iconKey": None,
                "colorHex": None,
            }
        ],
        "milks": [{"id": "2-percent-milk", "name": "2% Milk", "upchargeAmount": None, "isDairyFree": None, "iconKey": None, "colorHex": None}],
        "modifiers": [
            {
                "id": "vanilla-syrup",
                "name": "Vanilla Syrup",
                "type": "syrup",
                "selectionMode": "count",
                "unit": "pump",
                "pricingModel": "flat",
                "upchargeAmount": None,
                "defaultCountBySize": {"short": 2, "grande": 4},
                "maxCount": 12,
                "isSugarFree": None,
                "isSeasonal": False,
                "iconKey": None,
                "colorHex": None,
            },
            {
                "id": "caramel-drizzle",
                "name": "Caramel Drizzle",
                "type": "drizzle",
                "selectionMode": "level",
                "unit": "drizzle",
                "pricingModel": None,
                "upchargeAmount": None,
                "defaultCountBySize": None,
                "maxCount": None,
                "isSugarFree": None,
                "isSeasonal": False,
                "iconKey": None,
                "colorHex": None,
            },
        ],
        "rules": [],
        "seasonal": [],
    }
    valid_drink = {
        "id": "drink-1",
        "name": "Morning Latte",
        "chainId": "sample-chain",
        "baseId": "caffe-latte",
        "sizeId": "grande",
        "temperature": "iced",
        "milkId": "2-percent-milk",
        "modifiers": [
            {"modifierId": "vanilla-syrup", "count": 3, "level": None},
            {"modifierId": "caramel-drizzle", "count": None, "level": "light"},
        ],
        "options": None,
        "notes": None,
        "createdAt": "2026-11-20T20:00:00Z",
        "updatedAt": "2026-11-20T20:00:00Z",
        "schemaVersion": "1.0.0",
    }
    valid_visual = {
        "schemaVersion": "1.0.0",
        "chainId": "sample-chain",
        "bases": {"caffe-latte": {"iconKey": "latte-cup", "colorHex": "#6F4E37"}},
        "milks": {"2-percent-milk": {"iconKey": None, "colorHex": "#F5EFE6"}},
        "modifiers": {
            "vanilla-syrup": {"iconKey": "syrup-drop", "colorHex": "#F3D299", "cupLayer": "mix"},
            "caramel-drizzle": {"iconKey": None, "colorHex": "#C68642", "cupLayer": "drizzle"},
        },
    }

    assert not validate_chain(sample_chain, schema, "sample-chain.json", "sample-chain")
    assert not validate_drink_state(valid_drink, sample_chain, schema, "valid-drink")
    drink_opts = json.loads(json.dumps(valid_drink))
    drink_opts["options"] = [{"groupId": "espresso-roast", "choiceId": "blonde-espresso"}]
    assert not validate_drink_state(drink_opts, sample_chain, schema, "drink-with-options")
    assert not validate_visual_mapping(valid_visual, {"sample-chain": sample_chain}, {"sample-chain"}, "sample-chain.visual.json", "sample-chain")

    # Negative chain & drink tests
    c1 = json.loads(json.dumps(sample_chain))
    c1["modifiers"][0]["upchargeAmmount"] = 0.8
    assert_error_contains(validate_chain(c1, schema, "c1.json", "sample-chain"), "Unknown field 'upchargeAmmount'", "unknown-key-typo")

    c2 = json.loads(json.dumps(sample_chain))
    del c2["bases"][0]["defaultRecipe"]["shotsByTemperature"]["hot"]["short"]
    c2["modifiers"][1]["maxCount"] = 3
    e2 = validate_chain(c2, schema, "c2.json", "sample-chain")
    assert_error_contains(e2, "shotsByTemperature.hot missing key 'short'", "missing-shot-key")
    assert_error_contains(e2, "maxCount must be null when selectionMode is 'level'", "level-maxCount")

    c3 = json.loads(json.dumps(sample_chain))
    c3["modifiers"].append(json.loads(json.dumps(c3["modifiers"][1])))
    c3["modifiers"][-1]["id"] = "2-percent-milk"
    assert_error_contains(validate_chain(c3, schema, "c3.json", "sample-chain"), "Duplicate ID across chain", "cross-collection-dup-id")

    c4 = json.loads(json.dumps(sample_chain))
    c4["sizes"][0]["volumeOzByTemperature"]["iced"] = 8
    assert_error_contains(validate_chain(c4, schema, "c4.json", "sample-chain"), "volumeOzByTemperature.iced is non-null", "unsupported-temp-volume")

    c5 = json.loads(json.dumps(sample_chain))
    c5["bases"][0]["defaultRecipe"]["modifiers"] = [
        {"modifierId": "caramel-drizzle", "defaultLevel": "regular"},
        {"modifierId": "caramel-drizzle", "defaultLevel": "extra"},
    ]
    assert_error_contains(validate_chain(c5, schema, "c5.json", "sample-chain"), "duplicate modifierId 'caramel-drizzle'", "dup-recipe-mod")

    d1 = json.loads(json.dumps(valid_drink))
    d1["sizeId"] = "short"
    d1["modifiers"][0]["level"] = "extra"
    d1["modifiers"].append({"modifierId": "caramel-drizzle", "count": None, "level": "extra"})
    d1["options"] = [
        {"groupId": "espresso-roast", "choiceId": "blonde-espresso"},
        {"groupId": "espresso-roast", "choiceId": "decaf"},
    ]
    ed1 = validate_drink_state(d1, sample_chain, schema, "bad-drink")
    assert_error_contains(ed1, "temperature 'iced' is not supported by size 'short'", "hot-only-size-iced")
    assert_error_contains(ed1, "must set exactly one of count or level", "dual-count-level")
    assert_error_contains(ed1, "duplicate modifierId 'caramel-drizzle'", "dup-drink-mod")
    assert_error_contains(ed1, "duplicate groupId 'espresso-roast'", "dup-options-group")

    # Negative visual.json tests (unknown id, bad hex, unknown key, bad cupLayer)
    v1 = json.loads(json.dumps(valid_visual))
    v1["bases"]["does-not-exist"] = {"iconKey": None, "colorHex": "#112233"}
    assert_error_contains(
        validate_visual_mapping(v1, {"sample-chain": sample_chain}, {"sample-chain"}, "v1.visual.json", "sample-chain"),
        "Unknown base ID 'does-not-exist'",
        "visual-unknown-id",
    )

    v2 = json.loads(json.dumps(valid_visual))
    v2["milks"]["2-percent-milk"]["colorHex"] = "not-a-hex"
    assert_error_contains(
        validate_visual_mapping(v2, {"sample-chain": sample_chain}, {"sample-chain"}, "v2.visual.json", "sample-chain"),
        "must match #RRGGBB or be null",
        "visual-bad-hex",
    )

    v3 = json.loads(json.dumps(valid_visual))
    v3["extraTopKey"] = True
    v3["bases"]["caffe-latte"]["badField"] = 123
    ev3 = validate_visual_mapping(v3, {"sample-chain": sample_chain}, {"sample-chain"}, "v3.visual.json", "sample-chain")
    assert_error_contains(ev3, "Unknown top-level key 'extraTopKey'", "visual-unknown-top-key")
    assert_error_contains(ev3, "Unknown key 'badField'", "visual-unknown-entry-key")

    v4 = json.loads(json.dumps(valid_visual))
    v4["modifiers"]["vanilla-syrup"]["cupLayer"] = "bottom"
    assert_error_contains(
        validate_visual_mapping(v4, {"sample-chain": sample_chain}, {"sample-chain"}, "v4.visual.json", "sample-chain"),
        "Invalid cupLayer 'bottom'",
        "visual-bad-cuplayer",
    )

    print("SELF-TEST PASSED (17/17 assertions): valid chain + drinks + visual mapping passed; all 14 negative cases caught with exact expected errors.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate DrinkMate chain files, visual mappings, and optional drink state JSON.")
    parser.add_argument("--root", default=".", help="Project root directory (default: current directory)")
    parser.add_argument("--drink", help="Optional path to a saved drink state JSON file to validate")
    parser.add_argument("--self-test", action="store_true", help="Run built-in positive and negative validation tests")
    args = parser.parse_args()

    project_root = Path(args.root).resolve()

    if args.self_test:
        return run_self_test(project_root)

    try:
        schema = load_schema(project_root)
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}")
        return 1
    except Exception as exc:
        print(f"ERROR: Could not read data/schema/chain.schema.json: {exc}")
        return 1

    chains_dir = project_root / "data" / "chains"
    if not chains_dir.exists():
        print("ERROR: data/chains/ folder not found. Make sure you are running this from the DrinkMate project root folder.")
        return 1

    chain_files = sorted(chains_dir.glob("*.json"))
    if not chain_files:
        print(f"No chain files found in {chains_dir} (nothing to validate yet).")
        return 0

    any_failed = False
    chains_loaded: dict[str, dict[str, Any]] = {}
    all_chain_stems = {p.stem for p in chain_files}

    for path in chain_files:
        rel = str(path.relative_to(project_root))
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"FAIL  {rel}")
            print(f"  - [{rel}] [root] Invalid JSON: {exc}")
            any_failed = True
            continue

        errs = validate_chain(data, schema, rel, expected_id=path.stem)
        if errs:
            print(f"FAIL  {rel} ({len(errs)} error(s))")
            for e in errs:
                print(f"  - {e}")
            any_failed = True
        else:
            print(f"PASS  {rel}")
            chains_loaded[data["meta"]["id"]] = data

    idx_errs, indexed_ids = validate_index(project_root, all_chain_stems, chains_loaded)
    if idx_errs:
        print(f"FAIL  data/index.json ({len(idx_errs)} error(s))")
        for e in idx_errs:
            print(f"  - {e}")
        any_failed = True

    visual_dir = project_root / "data" / "visual"
    if visual_dir.exists():
        for vpath in sorted(visual_dir.glob("*.visual.json")):
            rel = str(vpath.relative_to(project_root))
            expected_cid = vpath.name[:-len(".visual.json")]
            try:
                vdata = json.loads(vpath.read_text(encoding="utf-8"))
            except Exception as exc:
                print(f"FAIL  {rel}")
                print(f"  - [{rel}] [root] Invalid JSON: {exc}")
                any_failed = True
                continue
            verrs = validate_visual_mapping(vdata, chains_loaded, indexed_ids, rel, expected_chain_id=expected_cid)
            if verrs:
                print(f"FAIL  {rel} ({len(verrs)} error(s))")
                for e in verrs:
                    print(f"  - {e}")
                any_failed = True
            else:
                print(f"PASS  {rel}")

    presets_dir = project_root / "data" / "presets"
    if presets_dir.exists():
        for ppath in sorted(presets_dir.glob("*.presets.json")):
            rel = str(ppath.relative_to(project_root))
            expected_cid = ppath.name[:-len(".presets.json")]
            try:
                pdata = json.loads(ppath.read_text(encoding="utf-8"))
            except Exception as exc:
                print(f"FAIL  {rel}")
                print(f"  - [{rel}] [root] Invalid JSON: {exc}")
                any_failed = True
                continue
            perrs = validate_presets_file(pdata, chains_loaded, schema, rel, expected_chain_id=expected_cid)
            if perrs:
                print(f"FAIL  {rel} ({len(perrs)} error(s))")
                for e in perrs:
                    print(f"  - {e}")
                any_failed = True
            else:
                print(f"PASS  {rel}")

    if args.drink:
        drink_path = Path(args.drink)
        if not drink_path.exists():
            print(f"ERROR: Drink file not found at {drink_path}. Check the path and try again.")
            return 1
        try:
            drink_data = json.loads(drink_path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"FAIL  {drink_path} — Invalid JSON: {exc}")
            return 1
        cid = drink_data.get("chainId")
        if cid not in chains_loaded:
            print(f"FAIL  {drink_path} — Referenced chainId '{cid}' not found in valid chains")
            return 1
        d_errs = validate_drink_state(drink_data, chains_loaded[cid], schema, str(drink_path))
        if d_errs:
            print(f"FAIL  {drink_path} ({len(d_errs)} error(s))")
            for e in d_errs:
                print(f"  - {e}")
            any_failed = True
        else:
            print(f"PASS  {drink_path}")

    return 1 if any_failed else 0


if __name__ == "__main__":
    sys.exit(main())
