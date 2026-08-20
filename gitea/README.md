# gitea

Skill only — no code. It documents [`tea`](https://gitea.com/gitea/tea), Gitea's
official CLI, which comes from nixpkgs; this package ships just the skill so an
agent knows how to drive it for issue work.

```nix
home.packages = [ pkgs.tea ];
```

`tea` already handles several instances: each is a named login (server URL +
token) in `$XDG_CONFIG_HOME/tea/config.yml`, added once with `tea logins add`.
The skill's job is mostly to keep an agent from getting that wrong — outside a
matching clone tea falls back to the _first_ login without asking, so `-l` is
mandatory there, and `-r` takes an `owner/repo` slug, never a URL.

It also records the gaps found by testing against a live Gitea: labels that do
not exist are silently dropped on create/edit, and comment editing, deletion,
reactions and locking have no subcommand at all — those go through `tea api`.

See [skill/SKILL.md](skill/SKILL.md).
