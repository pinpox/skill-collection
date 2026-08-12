# skill-collection

CLI tools and the agent skills that document them.

## Tools

| Tool                            | Description                                                                  | Skill                                    |
| ------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------- |
| [kleinanzeigen](kleinanzeigen/) | Search kleinanzeigen.de, read notifications, read and write account messages | [SKILL.md](kleinanzeigen/skill/SKILL.md) |

Each tool ships its skill definition under `<tool>/skill/` (installed to
`$out/share/skills/<tool>/`). The home-manager modules symlink that into the
agent skill directories, so Claude Code, omp and friends discover them
automatically.

## Installation

### Using Nix flakes

```bash
nix run github:pinpox/skill-collection#kleinanzeigen

# Add to your flake inputs
{
  inputs.skill-collection.url = "github:pinpox/skill-collection";
}
```

### Using home-manager

Per skill — import just the ones you want:

```nix
{
  imports = [ inputs.skill-collection.homeModules.kleinanzeigen ];
}
```

Or the option module, which installs every skill by default:

```nix
{
  imports = [ inputs.skill-collection.homeModules.default ];

  programs.skill-collection = {
    enable = true;
    package = inputs.skill-collection.packages.${pkgs.stdenv.hostPlatform.system};
    skills = [ "kleinanzeigen" ]; # optional, defaults to all
  };
}
```

Both variants take `programs.skill-collection.skillDirs`, which defaults to
`[ ".claude/skills" ".omp/agent/skills" ]` — one entry per agent harness that
should see the skills.

### Without home-manager

The skill definitions live inside the package output, so any harness can be
pointed straight at them:

```bash
nix build github:pinpox/skill-collection#kleinanzeigen
ls result/share/skills/kleinanzeigen/SKILL.md
```

## Adding a tool

1. `mkdir <tool>` with `default.nix`, the sources, a `README.md` and
   `skill/SKILL.md`. The package's `postInstall` copies `./skill` to
   `$out/share/skills/<tool>`.
2. Register the package in [`nix/packages.nix`](nix/packages.nix) and the skill
   in [`nix/skills.nix`](nix/skills.nix).
3. `nix flake check` builds every package and runs the formatter check;
   `nix fmt` formats.
