import { useEffect, useMemo, useRef, useState } from "react";
import { LayerImageStore, layerImageRequests, type AssetFetcher } from "@psd-studio/canvas-renderer";
import type { SceneGraph } from "@psd-studio/scene-graph";

/** Layer rasters decode at no more than this many pixels on the scene's long edge. */
const MAX_DECODE_DIMENSION = 2400;

export interface LayerImages {
  store: LayerImageStore | null;
  /** Bumps (at most once per frame) whenever another layer image finishes loading. */
  version: number;
  total: number;
  loaded: number;
  failed: number;
}

/** One store per storeKey (e.g. template version), so refetching the same graph never refetches its rasters. */
export function useLayerImages(storeKey: string, graph: SceneGraph | null, fetcher: AssetFetcher): LayerImages {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const [store, setStore] = useState<LayerImageStore | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const next = new LayerImageStore((assetId, signal) => fetcherRef.current(assetId, signal));
    setStore(next);
    return () => next.dispose();
  }, [storeKey]);

  useEffect(() => {
    if (!store || !graph) return;
    let frame = 0;
    const bump = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setVersion((v) => v + 1);
      });
    };
    const decodeScale = Math.min(1, MAX_DECODE_DIMENSION / Math.max(graph.width, graph.height));
    void store.load(layerImageRequests(graph, decodeScale), bump);
  }, [store, graph]);

  const total = useMemo(() => (graph ? new Set(layerImageRequests(graph, 1).map((r) => r.assetId)).size : 0), [graph]);
  return { store, version, total, loaded: store?.loadedCount ?? 0, failed: store?.failedCount ?? 0 };
}
