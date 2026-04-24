from __future__ import annotations

import importlib
import os
from collections import deque
from io import BytesIO
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image


app = FastAPI(title="xCloth Inference Service", version="0.1.0")


def _normalize_external_model_payload(model: Any) -> dict[str, Any] | None:
    if not isinstance(model, dict):
        return None

    if model.get("format") == "tri-mesh":
        positions = model.get("positions")
        uvs = model.get("uvs")
        indices = model.get("indices")
        if (
            isinstance(positions, list)
            and isinstance(uvs, list)
            and isinstance(indices, list)
            and len(positions) >= 9
            and len(positions) % 3 == 0
            and len(uvs) >= 6
            and len(uvs) % 2 == 0
            and len(indices) >= 3
            and len(indices) % 3 == 0
        ):
            return {
                "framework": model.get("framework") or "xcloth-external",
                "format": "tri-mesh",
                "positions": positions,
                "uvs": uvs,
                "indices": indices,
                "resolution": model.get("resolution"),
                "textureDataUrl": model.get("textureDataUrl"),
            }

    if model.get("format") == "glb-base64" and isinstance(model.get("glbBase64"), str):
        return {
            "framework": model.get("framework") or "xcloth-external",
            "format": "glb-base64",
            "glbBase64": model.get("glbBase64"),
        }

    return None


class ExternalXClothRunner:
    def __init__(self) -> None:
        self._loaded = False
        self._infer_fn = None
        self._checkpoint_path = None
        self._load_error = None

    def _load(self) -> None:
        if self._loaded:
            return

        self._loaded = True
        module_name = os.getenv("XCLOTH_MODEL_MODULE", "").strip()
        function_name = os.getenv("XCLOTH_MODEL_FUNCTION", "infer_garment_model").strip()
        self._checkpoint_path = os.getenv("XCLOTH_MODEL_CHECKPOINT", "").strip() or None

        if not module_name:
            return

        try:
            module = importlib.import_module(module_name)
            infer_fn = getattr(module, function_name)
            if not callable(infer_fn):
                raise TypeError(f"{module_name}.{function_name} is not callable")
            self._infer_fn = infer_fn
        except Exception as error:
            self._load_error = str(error)
            self._infer_fn = None

    def infer(
        self,
        image_bytes: bytes,
        garment_type: str,
        cutout_data_url: str | None,
    ) -> tuple[dict[str, Any] | None, str | None]:
        self._load()
        if self._load_error:
            return None, self._load_error
        if self._infer_fn is None:
            return None, None

        try:
            result = self._infer_fn(
                image_bytes=image_bytes,
                garment_type=garment_type,
                cutout_data_url=cutout_data_url,
                checkpoint_path=self._checkpoint_path,
            )
        except TypeError:
            result = self._infer_fn(image_bytes, garment_type, self._checkpoint_path)
        except Exception as error:
            return None, str(error)

        normalized = _normalize_external_model_payload(result)
        if normalized is None:
            return None, "External model returned an invalid payload format"

        return normalized, None


external_xcloth_runner = ExternalXClothRunner()


def _decode_data_url_png(data_url: str) -> bytes:
    if not data_url or "," not in data_url:
        raise ValueError("Invalid data URL")
    header, payload = data_url.split(",", 1)
    if "base64" not in header:
        raise ValueError("Expected base64 data URL")
    import base64

    return base64.b64decode(payload)


def _read_rgba_image(image_bytes: bytes) -> Image.Image:
    return Image.open(BytesIO(image_bytes)).convert("RGBA")


def _resize_keep_aspect(rgba: Image.Image, max_side: int = 96) -> Image.Image:
    w, h = rgba.size
    if max(h, w) <= max_side:
        return rgba

    scale = max_side / float(max(h, w))
    new_w = max(2, int(round(w * scale)))
    new_h = max(2, int(round(h * scale)))

    return rgba.resize((new_w, new_h), Image.Resampling.BILINEAR)


def _mask_from_rgba(rgba: Image.Image) -> tuple[int, int, list[tuple[int, int, int, int]], list[bool]]:
    w, h = rgba.size
    pixels = list(rgba.getdata())
    max_alpha = max(pixel[3] for pixel in pixels)

    mask = [False] * (w * h)
    if max_alpha > 5:
        for index, pixel in enumerate(pixels):
            mask[index] = pixel[3] > 24
    else:
        for index, pixel in enumerate(pixels):
            red, green, blue, _ = pixel
            luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
            mask[index] = luminance < 244

    return w, h, pixels, mask


def _largest_component_mask(mask: list[bool], width: int, height: int) -> list[bool]:
    visited = [False] * (width * height)
    best_component: list[int] = []

    for start in range(width * height):
        if not mask[start] or visited[start]:
            continue

        queue: deque[int] = deque([start])
        visited[start] = True
        component: list[int] = []

        while queue:
            current = queue.popleft()
            component.append(current)

            x = current % width
            y = current // width

            if x > 0:
                left = current - 1
                if mask[left] and not visited[left]:
                    visited[left] = True
                    queue.append(left)
            if x < width - 1:
                right = current + 1
                if mask[right] and not visited[right]:
                    visited[right] = True
                    queue.append(right)
            if y > 0:
                up = current - width
                if mask[up] and not visited[up]:
                    visited[up] = True
                    queue.append(up)
            if y < height - 1:
                down = current + width
                if mask[down] and not visited[down]:
                    visited[down] = True
                    queue.append(down)

        if len(component) > len(best_component):
            best_component = component

    out = [False] * (width * height)
    for index in best_component:
        out[index] = True
    return out


def _fill_small_holes(mask: list[bool], width: int, height: int, max_hole_size: int = 64) -> list[bool]:
    visited = [False] * (width * height)
    out = list(mask)

    for start in range(width * height):
        if mask[start] or visited[start]:
            continue

        queue: deque[int] = deque([start])
        visited[start] = True
        component: list[int] = []
        touches_border = False

        while queue:
            current = queue.popleft()
            component.append(current)
            x = current % width
            y = current // width

            if x == 0 or y == 0 or x == width - 1 or y == height - 1:
                touches_border = True

            if x > 0:
                left = current - 1
                if not mask[left] and not visited[left]:
                    visited[left] = True
                    queue.append(left)
            if x < width - 1:
                right = current + 1
                if not mask[right] and not visited[right]:
                    visited[right] = True
                    queue.append(right)
            if y > 0:
                up = current - width
                if not mask[up] and not visited[up]:
                    visited[up] = True
                    queue.append(up)
            if y < height - 1:
                down = current + width
                if not mask[down] and not visited[down]:
                    visited[down] = True
                    queue.append(down)

        if not touches_border and len(component) <= max_hole_size:
            for index in component:
                out[index] = True

    return out


def _boundary_mask(mask: list[bool], width: int, height: int) -> list[bool]:
    boundary = [False] * (width * height)
    for index, is_fg in enumerate(mask):
        if not is_fg:
            continue

        x = index % width
        y = index // width
        is_boundary = x == 0 or y == 0 or x == width - 1 or y == height - 1
        if not is_boundary:
            is_boundary = (
                not mask[index - 1]
                or not mask[index + 1]
                or not mask[index - width]
                or not mask[index + width]
            )

        if is_boundary:
            boundary[index] = True

    return boundary


def _build_vertex_adjacency(vertex_count: int, indices: list[int]) -> list[set[int]]:
    adjacency = [set() for _ in range(vertex_count)]
    for tri in range(0, len(indices), 3):
        first = indices[tri]
        second = indices[tri + 1]
        third = indices[tri + 2]

        adjacency[first].add(second)
        adjacency[first].add(third)
        adjacency[second].add(first)
        adjacency[second].add(third)
        adjacency[third].add(first)
        adjacency[third].add(second)

    return adjacency


def _laplacian_smooth(
    positions: list[float],
    indices: list[int],
    pinned_vertices: list[bool],
    iterations: int = 2,
    alpha: float = 0.2,
) -> None:
    vertex_count = len(positions) // 3
    if vertex_count == 0:
        return

    adjacency = _build_vertex_adjacency(vertex_count, indices)

    for _ in range(max(0, iterations)):
        updated = list(positions)
        for vertex in range(vertex_count):
            if pinned_vertices[vertex]:
                continue

            neighbors = adjacency[vertex]
            if not neighbors:
                continue

            avg_x = 0.0
            avg_y = 0.0
            avg_z = 0.0
            for n in neighbors:
                avg_x += positions[n * 3]
                avg_y += positions[n * 3 + 1]
                avg_z += positions[n * 3 + 2]

            inv = 1.0 / len(neighbors)
            avg_x *= inv
            avg_y *= inv
            avg_z *= inv

            base = vertex * 3
            updated[base] = positions[base] * (1.0 - alpha) + avg_x * alpha
            updated[base + 1] = positions[base + 1] * (1.0 - alpha) + avg_y * alpha
            updated[base + 2] = positions[base + 2] * (1.0 - alpha) + avg_z * alpha

        positions[:] = updated


def _distance_from_background(mask: list[bool], width: int, height: int) -> list[float]:
    inf = 1e9
    dist = [inf] * (width * height)

    queue: deque[tuple[int, int]] = deque()
    for y in range(height):
        row_start = y * width
        for x in range(width):
            index = row_start + x
            if not mask[index]:
                dist[index] = 0.0
                queue.append((x, y))

    if not queue:
        return [0.0] * (width * height)

    while queue:
        x, y = queue.popleft()
        current_index = y * width + x
        next_val = dist[current_index] + 1.0

        if x > 0:
            left = current_index - 1
            if next_val < dist[left]:
                dist[left] = next_val
                queue.append((x - 1, y))
        if x < width - 1:
            right = current_index + 1
            if next_val < dist[right]:
                dist[right] = next_val
                queue.append((x + 1, y))
        if y > 0:
            up = current_index - width
            if next_val < dist[up]:
                dist[up] = next_val
                queue.append((x, y - 1))
        if y < height - 1:
            down = current_index + width
            if next_val < dist[down]:
                dist[down] = next_val
                queue.append((x, y + 1))

    for index, is_fg in enumerate(mask):
        if not is_fg:
            dist[index] = 0.0

    return dist


def _build_trimesh(
    width: int,
    height: int,
    pixels: list[tuple[int, int, int, int]],
    mask: list[bool],
    dist: list[float],
) -> dict[str, Any]:
    if height < 2 or width < 2:
        raise ValueError("Image too small for mesh extraction")

    fg_count = sum(1 for value in mask if value)
    if fg_count < 24:
        raise ValueError("Not enough foreground garment pixels")

    max_dist = 1.0
    for index, is_fg in enumerate(mask):
        if is_fg and dist[index] > max_dist:
            max_dist = dist[index]
    max_dist = max(1.0, max_dist)

    mask = _largest_component_mask(mask, width, height)
    mask = _fill_small_holes(mask, width, height, max_hole_size=96)
    boundary = _boundary_mask(mask, width, height)

    front_vertex_map = [-1] * (width * height)
    back_vertex_map = [-1] * (width * height)

    positions: list[float] = []
    uvs: list[float] = []
    indices: list[int] = []
    pinned_vertices: list[bool] = []

    aspect = width / max(1.0, float(height))
    scale_y = 1.35
    scale_x = scale_y * aspect

    for y in range(height):
        row_start = y * width
        for x in range(width):
            index = row_start + x
            if not mask[index]:
                continue

            red, green, blue, _ = pixels[index]
            lum = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255.0

            d_norm = min(1.0, float(dist[index]) / max_dist)
            wrinkle = (0.5 - lum) * 0.02
            front_z = 0.018 + d_norm * 0.08 + wrinkle
            back_z = -0.018 - d_norm * 0.05 + wrinkle * 0.35

            x_norm = ((x / max(1.0, (width - 1))) - 0.5) * 2.0
            y_norm = (0.5 - (y / max(1.0, (height - 1)))) * 2.0
            px = x_norm * scale_x
            py = y_norm * scale_y + 1.1

            front_index = len(positions) // 3
            positions.extend([px, py, front_z])
            uvs.extend([x / max(1.0, (width - 1)), 1.0 - y / max(1.0, (height - 1))])
            front_vertex_map[index] = front_index
            pinned_vertices.append(boundary[index])

            back_index = len(positions) // 3
            positions.extend([px, py, back_z])
            uvs.extend([x / max(1.0, (width - 1)), 1.0 - y / max(1.0, (height - 1))])
            back_vertex_map[index] = back_index
            pinned_vertices.append(boundary[index])

    for y in range(height - 1):
        for x in range(width - 1):
            i00 = y * width + x
            i10 = i00 + 1
            i01 = i00 + width
            i11 = i01 + 1

            f00 = front_vertex_map[i00]
            f10 = front_vertex_map[i10]
            f01 = front_vertex_map[i01]
            f11 = front_vertex_map[i11]

            if f00 >= 0 and f10 >= 0 and f01 >= 0:
                indices.extend([f00, f10, f01])
            if f10 >= 0 and f11 >= 0 and f01 >= 0:
                indices.extend([f10, f11, f01])

            b00 = back_vertex_map[i00]
            b10 = back_vertex_map[i10]
            b01 = back_vertex_map[i01]
            b11 = back_vertex_map[i11]

            if b00 >= 0 and b01 >= 0 and b10 >= 0:
                indices.extend([b00, b01, b10])
            if b10 >= 0 and b01 >= 0 and b11 >= 0:
                indices.extend([b10, b01, b11])

    # Stitch front and back layers near silhouette boundaries to improve closed-surface quality.
    for y in range(height):
        for x in range(width):
            i00 = y * width + x
            if not mask[i00]:
                continue

            f00 = front_vertex_map[i00]
            b00 = back_vertex_map[i00]
            if f00 < 0 or b00 < 0:
                continue

            if x < width - 1:
                i10 = i00 + 1
                if mask[i10] and (boundary[i00] or boundary[i10]):
                    f10 = front_vertex_map[i10]
                    b10 = back_vertex_map[i10]
                    if f10 >= 0 and b10 >= 0:
                        indices.extend([f00, f10, b10])
                        indices.extend([f00, b10, b00])

            if y < height - 1:
                i01 = i00 + width
                if mask[i01] and (boundary[i00] or boundary[i01]):
                    f01 = front_vertex_map[i01]
                    b01 = back_vertex_map[i01]
                    if f01 >= 0 and b01 >= 0:
                        indices.extend([f00, b01, f01])
                        indices.extend([f00, b00, b01])

    _laplacian_smooth(
        positions=positions,
        indices=indices,
        pinned_vertices=pinned_vertices,
        iterations=2,
        alpha=0.18,
    )

    if len(indices) < 3:
        raise ValueError("Failed to triangulate garment surface")

    return {
        "framework": "xcloth-service-local",
        "format": "tri-mesh",
        "positions": positions,
        "uvs": uvs,
        "indices": indices,
        "quality": {
            "foregroundPixels": fg_count,
            "boundaryPixels": sum(1 for value in boundary if value),
            "smoothingIterations": 2,
            "sideStitching": True,
        },
        "resolution": {
            "width": int(width),
            "height": int(height),
        },
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/infer")
async def infer(
    image: UploadFile = File(...),
    garmentType: str = Form("shirt"),
    cutoutDataUrl: str | None = Form(None),
) -> dict[str, Any]:
    try:
        if cutoutDataUrl:
            image_bytes = _decode_data_url_png(cutoutDataUrl)
        else:
            image_bytes = await image.read()

        external_model, external_error = external_xcloth_runner.infer(
            image_bytes=image_bytes,
            garment_type=garmentType,
            cutout_data_url=cutoutDataUrl,
        )

        if external_model is not None:
            if not external_model.get("textureDataUrl"):
                import base64

                external_model["textureDataUrl"] = "data:image/png;base64," + base64.b64encode(
                    image_bytes
                ).decode("ascii")

            return {
                "ok": True,
                "garmentType": garmentType,
                "garmentModel": external_model,
                "modelSource": "external",
            }

        rgba = _read_rgba_image(image_bytes)
        rgba = _resize_keep_aspect(rgba, max_side=96)
        width, height, pixels, mask = _mask_from_rgba(rgba)
        dist = _distance_from_background(mask, width, height)
        model = _build_trimesh(width, height, pixels, mask, dist)

        import base64

        model["textureDataUrl"] = "data:image/png;base64," + base64.b64encode(
            image_bytes
        ).decode("ascii")

        return {
            "ok": True,
            "garmentType": garmentType,
            "garmentModel": model,
            "modelSource": "fallback",
            "externalModelError": external_error,
        }
    except Exception as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
