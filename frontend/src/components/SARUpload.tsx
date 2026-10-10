import { useState } from "react";
import { uploadSAR, type IncidentReport } from "../api/incidents";

export function SARUpload({
  onSuccess,
  disabled,
  forecastHours,
  hindcastHours,
}: {
  onSuccess: (r: IncidentReport) => void;
  disabled: boolean;
  forecastHours: number;
  hindcastHours: number;
}) {
  const [vv, setVV] = useState<File | null>(null);
  const [vh, setVH] = useState<File | null>(null);
  const [date, setDate] = useState("");
  const [units, setUnits] = useState("db");
  const [attested, setAttested] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState("");
  return (
    <section className="space-y-3 rounded border border-border p-4" aria-label="SAR upload">
      <h2 className="font-medium">UPLOAD · calibrated SAR subset</h2>
      <p className="text-sm">
        Two co-registered VV/VH FLOAT32 GeoTIFFs, 512×512, north-up EPSG:4326 PixelIsArea, maximum 8
        MiB each and 0.2° per side. Ordinary RGB photographs and display PNG/JPEG images are not
        supported SAR evidence.
      </p>
      <div className="flex flex-wrap gap-4">
        <label>
          VV GeoTIFF
          <input
            aria-label="VV GeoTIFF"
            className="block"
            type="file"
            accept=".tif,.tiff"
            disabled={pending}
            onChange={(e) => {
              setVV(e.target.files?.[0] ?? null);
              setError("");
            }}
          />
        </label>
        <label>
          VH GeoTIFF
          <input
            aria-label="VH GeoTIFF"
            className="block"
            type="file"
            accept=".tif,.tiff"
            disabled={pending}
            onChange={(e) => {
              setVH(e.target.files?.[0] ?? null);
              setError("");
            }}
          />
        </label>
        <label>
          Acquisition time (UTC)
          <input
            aria-label="Acquisition time UTC"
            className="block bg-secondary p-2"
            type="datetime-local"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={pending}
          />
        </label>
        <label>
          Calibrated units
          <select
            className="block bg-secondary p-2"
            value={units}
            onChange={(e) => setUnits(e.target.value)}
          >
            <option value="db">sigma0 dB</option>
            <option value="linear">sigma0 linear</option>
          </select>
        </label>
      </div>
      <label className="block text-sm">
        <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />{" "}
        I confirm these are calibrated VV/VH SAR measurements, with the declared acquisition
        time—not photographs.
      </label>
      <button
        className="rounded border border-primary px-3 py-2 disabled:opacity-40"
        disabled={pending || disabled}
        onClick={async () => {
          setError("");
          setOutcome("");
          if (!vv || !vh || !date || !attested) {
            setError(
              "UPLOAD ERROR: choose both polarizations, an acquisition time, and confirm the SAR source.",
            );
            return;
          }
          setPending(true);
          try {
            const report = await uploadSAR(
              vv,
              vh,
              new Date(`${date}Z`).toISOString(),
              units,
              attested,
              forecastHours,
              hindcastHours,
            );
            setOutcome(report.outcome ?? report.status);
            onSuccess(report);
          } catch (err) {
            setError(
              err instanceof Error
                ? err.message
                : "UPLOAD ERROR: retry with supported SAR subsets.",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "Uploading and analyzing…" : "Analyze uploaded SAR"}
      </button>
      {pending && (
        <p role="status">
          Transferring bounded subsets → validating georeferencing → preprocessing → hybrid
          detection. Stage results follow completion; no simulated percentages.
        </p>
      )}
      {outcome && <p role="status">Upload analysis completed: {outcome}</p>}
      {error && (
        <div role="alert">{error} Your files remain selected; correct the input and retry.</div>
      )}
    </section>
  );
}
