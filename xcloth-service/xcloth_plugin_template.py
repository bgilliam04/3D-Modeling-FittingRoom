"""
Template plugin for real xCloth/SHARP model inference.

Set environment variables before starting uvicorn:
  XCLOTH_MODEL_MODULE=xcloth_plugin_template
  XCLOTH_MODEL_FUNCTION=infer_garment_model
  XCLOTH_MODEL_CHECKPOINT=C:/path/to/checkpoint.pt

Replace this implementation with your actual model pipeline.
"""

from __future__ import annotations

from typing import Any


def infer_garment_model(
    image_bytes: bytes,
    garment_type: str,
    checkpoint_path: str | None = None,
    **_: Any,
) -> dict[str, Any]:
    """
    Return one of the accepted payload formats:

    1) Tri-mesh:
      {
        "framework": "xcloth",
        "format": "tri-mesh",
        "positions": [...],
        "uvs": [...],
        "indices": [...],
        "textureDataUrl": "data:image/png;base64,..."
      }

    2) GLB base64:
      {
        "framework": "xcloth",
        "format": "glb-base64",
        "glbBase64": "..."
      }
    """
    raise NotImplementedError(
        "Replace xcloth_plugin_template.infer_garment_model with the real checkpoint inference code. "
        f"garment_type={garment_type}, checkpoint_path={checkpoint_path}"
    )
