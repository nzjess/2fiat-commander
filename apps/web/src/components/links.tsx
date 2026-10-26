import { Anchor, type AnchorProps, NavLink, type NavLinkProps } from "@mantine/core";
import { createLink, type LinkComponent } from "@tanstack/react-router";
import type { AnchorHTMLAttributes, Ref } from "react";

// Mantine components as router links, keeping the router's typed `to`, `params` and `search`. `createLink` needs
// plain (non-polymorphic) components, hence the wrappers.

type AnchorAttributes = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "color" | "style">;

function MantineAnchor(props: AnchorProps & AnchorAttributes & { ref?: Ref<HTMLAnchorElement> }) {
  return <Anchor {...props} />;
}

function MantineNavLink(props: NavLinkProps & AnchorAttributes & { ref?: Ref<HTMLAnchorElement> }) {
  return <NavLink {...props} />;
}

const CreatedAnchorLink = createLink(MantineAnchor);
const CreatedNavItem = createLink(MantineNavLink);

export const AnchorLink: LinkComponent<typeof MantineAnchor> = (props) => <CreatedAnchorLink {...props} />;
export const NavItem: LinkComponent<typeof MantineNavLink> = (props) => <CreatedNavItem {...props} />;
