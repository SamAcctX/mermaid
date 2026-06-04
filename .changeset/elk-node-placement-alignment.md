---
'mermaid': minor
'@mermaid-js/layout-elk': minor
---

feat: expose `elk.nodePlacementAlignment` to configure Brandes-Koepf fixed alignment in ELK layout

ELK now defaults Brandes-Koepf fixed alignment to `RIGHTDOWN`, matching Mermaid's intended
ELK layout positioning. Set `elk.nodePlacementAlignment` to another supported value, including
`NONE`, to opt into a different ELK alignment strategy.
