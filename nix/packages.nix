{
  callPackage,
}:
let
  mkSkill = callPackage ./mk-skill.nix { };
in
{
  # Documentation only; `tea` itself comes from nixpkgs.
  gitea = callPackage ../gitea { inherit mkSkill; };
  hedgedoc = callPackage ../hedgedoc { };
  kleinanzeigen = callPackage ../kleinanzeigen { };
  plann = callPackage ../plann { };
  todos = callPackage ../todos { inherit mkSkill; };
  zulip = callPackage ../zulip { };
}
