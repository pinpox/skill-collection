# todos

Skill only — no code. It documents [`vja`](https://gitlab.com/ce72/vja), the
Vikunja CLI, which comes from nixpkgs; this package ships just the skill so an
agent knows how to drive it.

```nix
home.packages = [ pkgs.vja ];
```

Beyond the command reference, the skill carries the conventions of one specific
Vikunja instance (which projects exist, what labels mean, when a due date is
appropriate). Adjust that section to your own setup before pointing an agent at
it, or it will confidently file things in the wrong place.

See [skill/SKILL.md](skill/SKILL.md).
