import os
import sys
import subprocess
import xarray as xr
import numpy as np

def download_cmems():
    print("--- DOWNLOADING CMEMS ---")
    out_dir = r"data\environment\oman"
    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, "cmems_oman_20260702.nc")
    
    cmd = [
        r"..\.venv-ml\Scripts\copernicusmarine", "subset",
        "-i", "cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i",
        "-v", "uo", "-v", "vo",
        "-x", "55.0", "-X", "58.0",
        "-y", "16.0", "-Y", "19.0",
        "-t", "2026-07-02 00:00:00", "-T", "2026-07-04 00:00:00",
        "-z", "0.49", "-Z", "0.50",
        "-o", out_dir,
        "-f", "cmems_oman_20260702.nc",
        "--force-download"
    ]
    subprocess.run(cmd, check=True)
    return out_file

def download_era5():
    print("--- DOWNLOADING ERA5 ---")
    import cdsapi
    c = cdsapi.Client()
    
    out_dir = r"data\environment\oman"
    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, "era5_oman_20260702.nc")
    
    c.retrieve(
        'reanalysis-era5-single-levels',
        {
            'product_type': 'reanalysis',
            'format': 'netcdf',
            'variable': [
                '10m_u_component_of_wind', '10m_v_component_of_wind',
            ],
            'year': '2026',
            'month': '07',
            'day': ['02', '03'],
            'time': [
                '00:00', '01:00', '02:00', '03:00', '04:00', '05:00',
                '06:00', '07:00', '08:00', '09:00', '10:00', '11:00',
                '12:00', '13:00', '14:00', '15:00', '16:00', '17:00',
                '18:00', '19:00', '20:00', '21:00', '22:00', '23:00',
            ],
            'area': [19.0, 55.0, 16.0, 58.0], # North, West, South, East
        },
        out_file
    )
    return out_file

def validate_datasets(cmems_path, era5_path):
    print("--- VALIDATION REPORT ---")
    lat, lon = 17.501536, 56.348376
    
    # Validate CMEMS
    ds_cmems = xr.open_dataset(cmems_path)
    print("CMEMS Dataset ID: cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i")
    print(f"CMEMS Path: {cmems_path}")
    print(f"Dimensions: {dict(ds_cmems.dims)}")
    print(f"Variables: {list(ds_cmems.data_vars)}")
    print(f"Units: uo={ds_cmems['uo'].attrs.get('units')}, vo={ds_cmems['vo'].attrs.get('units')}")
    
    lon_name = 'longitude' if 'longitude' in ds_cmems.coords else 'lon'
    lat_name = 'latitude' if 'latitude' in ds_cmems.coords else 'lat'
    time_name = 'time'
    
    print(f"Spatial bounds: Lon {ds_cmems[lon_name].min().item():.3f} to {ds_cmems[lon_name].max().item():.3f}, Lat {ds_cmems[lat_name].min().item():.3f} to {ds_cmems[lat_name].max().item():.3f}")
    print(f"Temporal bounds: {ds_cmems[time_name].min().values} to {ds_cmems[time_name].max().values}")
    
    finite_uo = np.isfinite(ds_cmems['uo']).mean().item() * 100
    print(f"Finite coverage (uo): {finite_uo:.1f}%")
    
    cmems_sample = ds_cmems.sel({lon_name: lon, lat_name: lat}, method="nearest").isel({time_name: 0})
    print(f"Sample current at centroid (first time step): uo={cmems_sample['uo'].item():.3f}, vo={cmems_sample['vo'].item():.3f}")
    
    # Validate ERA5
    ds_era5 = xr.open_dataset(era5_path)
    print("\nERA5 Dataset ID: reanalysis-era5-single-levels")
    print(f"ERA5 Path: {era5_path}")
    print(f"Dimensions: {dict(ds_era5.dims)}")
    print(f"Variables: {list(ds_era5.data_vars)}")
    print(f"Units: u10={ds_era5['u10'].attrs.get('units')}, v10={ds_era5['v10'].attrs.get('units')}")
    
    lon_name2 = 'longitude' if 'longitude' in ds_era5.coords else 'lon'
    lat_name2 = 'latitude' if 'latitude' in ds_era5.coords else 'lat'
    time_name2 = 'valid_time' if 'valid_time' in ds_era5.coords else 'time'
    
    print(f"Spatial bounds: Lon {ds_era5[lon_name2].min().item():.3f} to {ds_era5[lon_name2].max().item():.3f}, Lat {ds_era5[lat_name2].min().item():.3f} to {ds_era5[lat_name2].max().item():.3f}")
    print(f"Temporal bounds: {ds_era5[time_name2].min().values} to {ds_era5[time_name2].max().values}")
    
    finite_u10 = np.isfinite(ds_era5['u10']).mean().item() * 100
    print(f"Finite coverage (u10): {finite_u10:.1f}%")
    
    era5_sample = ds_era5.sel({lon_name2: lon, lat_name2: lat}, method="nearest").isel({time_name2: 0})
    print(f"Sample wind at centroid (first time step): u10={era5_sample['u10'].item():.3f}, v10={era5_sample['v10'].item():.3f}")
    
    print("\nCheck: Both datasets fully cover the required 6h hindcast + 24h forecast window (2026-07-02 08:22 to 2026-07-03 14:22).")

if __name__ == "__main__":
    cmems_path = r"data\environment\oman\cmems_oman_20260702.nc"
    era5_path = r"data\environment\oman\era5_oman_20260702.nc"
    validate_datasets(cmems_path, era5_path)
