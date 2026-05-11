---
'mermaid': minor
---

feat(class): add nested namespace support for class diagrams via dot notation and syntactic nesting

If you have namespaces in class diagrams that use `.`s already and want to render them without nesting (≤v11.14.0 behaviour), you can use set `class.hierarchicalNamespaces=false` in your mermaid config:

```yaml
config:
  class:
    hierarchicalNamespaces: false
```
