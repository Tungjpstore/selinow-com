# Global Homepage Asset Prompts

Generated through the authorized local 9Router OpenAI-compatible image route (`cx/gpt-5.5-image`). The final files are checked into `public/brand/selinow-kit/global/v2/` so the homepage does not depend on a browser session or an external image URL.

Shared constraints for every prompt:

- no words, letters, numbers, logos, flags, watermarks, UI screenshots, status badges, or locale-dependent copy;
- warm cloud-white backdrop `#f7f8f4` with no hard floor seam, so the raster surface blends with the landing canvas;
- Selinow palette: navy `#102a43`, teal `#2f9f90`, coral `#b44730`, lilac `#e7e7f5`;
- soft editorial 3D clay/satin-glass treatment, generous padding, and a minimum source dimension above 1,000px.

| File | Role | Source |
| --- | --- | --- |
| `hero-core.png` | Hero and architecture core visual | Wide orbital commerce operating system core; 1536x1024 |
| `channel-network.png` | Channel/use-case network visual and channels decoration | Six abstract communication nodes around a teal hub; 1254x1254 |
| `commerce-catalog.png` | Sales bot and catalog use cases | Shopping bag, product box, catalog tiles; 1254x1254 |
| `support-automation.png` | Support bot, notifications, and workflow step 1 | Abstract AI bot orb with signal bubbles; 1254x1254 |
| `delivery-payment.png` | Digital delivery, payment, and workflow steps 3–4 | Secure token flowing through a delivery cloud to a parcel; 1254x1254 |
| `public/brand/selinow-og-cover-global.png` | Shared EN/VI Open Graph and Twitter cover | Text-free crop of `hero-core.png`, resized to 1200x630 |

The HTML layer owns all channel names, readiness states, workflow copy, and translations. Raster assets are visual-only by design, so future channels and locale changes do not require another image generation pass.
