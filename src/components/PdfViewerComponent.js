import { useEffect, useRef, useState } from "react";

import {
  CustomContainer,
  load,
  unload,
} from "../examples/embeddedExternalToolbar";

function publicPath(path) {
  const publicUrl = process.env.PUBLIC_URL || "";

  return `${publicUrl}${path}`;
}

export default function PdfViewerComponent({ document }) {
  const containerRef = useRef(null);
  const [loadedInstance, setLoadedInstance] = useState(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container || process.env.NODE_ENV === "test") {
      return undefined;
    }

    let isMounted = true;

    load({
      container,
      document,
      // Use the public directory URL as a base URL. Nutrient will download its library assets from here.
      baseUrl: `${window.location.origin}${publicPath("/")}`,
    })
      .then((instance) => {
        if (isMounted) {
          setLoadedInstance({ instance });
        }
      })
      .catch((error) => {
        console.error("Failed to load Nutrient Web SDK:", error);
      });

    return () => {
      isMounted = false;
      setLoadedInstance(null);
      unload(container);
    };
  }, [document]);

  return <CustomContainer ref={containerRef} instance={loadedInstance} />;
}
