{
  callPackage,
}:
let
  mkSkill = callPackage ./mk-skill.nix { };
in
{
  hedgedoc = callPackage ../hedgedoc { };
  kleinanzeigen = callPackage ../kleinanzeigen { };
  plann = callPackage ../plann { };
  todos = callPackage ../todos { inherit mkSkill; };
  zulip = callPackage ../zulip { };
}
