// Zoeken van adressen, plaatsen en straten via de PDOK Locatieserver (gratis, geen sleutel).

export interface Place {
  name: string;
  type: string;
  lat: number;
  lon: number;
}

const URL_FREE = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";

export async function geocode(q: string, signal: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({
    q,
    rows: "7",
    fl: "weergavenaam,type,centroide_ll",
    fq: "type:(woonplaats OR adres OR weg OR postcode OR gemeente)",
  });
  const res = await fetch(`${URL_FREE}?${params}`, { signal });
  if (!res.ok) throw new Error(`PDOK ${res.status}`);
  const json = await res.json();
  const docs: { weergavenaam: string; type: string; centroide_ll: string }[] = json.response?.docs ?? [];
  return docs.flatMap((d) => {
    const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(d.centroide_ll);
    return m ? [{ name: d.weergavenaam, type: d.type, lon: +m[1], lat: +m[2] }] : [];
  });
}
