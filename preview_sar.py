from pathlib import Path
import numpy as np
import tifffile
import matplotlib.pyplot as plt

scene = Path(
    r"backend\data\scenes\S1D_IW_GRDH_1SDV_20261005T011017_20261005T011042_004873_0092A1_0488_COG.SAFE"
)

for name in ["vv", "vh"]:
    path = scene / f"{name}.tif"

    img = tifffile.imread(path).astype(np.float32)

    # Robust contrast stretch for SAR visualization
    finite = np.isfinite(img)
    values = img[finite]

    low, high = np.percentile(values, [2, 98])

    display = np.zeros_like(img, dtype=np.float32)

    finite_mask = np.isfinite(img)
    display[finite_mask] = np.clip(
        (img[finite_mask] - low) / (high - low),
        0,
        1
    )

    output = scene / f"{name}_preview.png"

    plt.imsave(output, display, cmap="gray")

    print(f"{name.upper()}:")
    print(f"  shape: {img.shape}")
    print(f"  dtype: {img.dtype}")
    print(f"  range: {np.nanmin(img)} → {np.nanmax(img)}")
    print(f"  preview: {output}")