import { Anchor, type AnchorProps, NavLink, type NavLinkProps } from "@mantine/core";
import { createLink, type LinkComponent, useParams } from "@tanstack/react-router";
import type { AnchorHTMLAttributes, Ref } from "react";
import { positiveInt } from "../lib/search.ts";

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

/** The logical card the current page is about, if any: the `c/$logicalCardId` in its path. */
export function useUrlCard(): number | undefined {
  return positiveInt(useParams({ strict: false }).logicalCardId);
}
