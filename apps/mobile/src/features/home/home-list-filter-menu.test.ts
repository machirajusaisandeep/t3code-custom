import { describe, expect, it, vi } from "vite-plus/test";

import { buildHomeListFilterMenu } from "./home-list-filter-menu";

describe("buildHomeListFilterMenu", () => {
  it("adds a project scope submenu that selects and clears the same scope as the chips", () => {
    const onProjectScopeChange = vi.fn();
    const menu = buildHomeListFilterMenu({
      environments: [],
      projects: [
        { key: "environment-1:project-1", label: "Codething" },
        { key: "environment-1:project-2", label: "Website" },
      ],
      selectedEnvironmentId: null,
      selectedProjectKeys: ["environment-1:project-1"],
      projectSortOrder: "updated_at",
      threadSortOrder: "updated_at",
      onEnvironmentChange: vi.fn(),
      onProjectScopeChange,
      onProjectSortOrderChange: vi.fn(),
      onThreadSortOrderChange: vi.fn(),
    });

    const projectMenu = menu.items.find(
      (item) => item.type === "submenu" && item.title === "Project",
    );
    expect(menu.items.some((item) => item.title === "Settings")).toBe(false);
    expect(projectMenu).toMatchObject({
      type: "submenu",
      items: [
        { title: "All projects", state: "off" },
        { title: "Select projects", state: "off" },
        { title: "Codething", state: "on" },
        { title: "Website", state: "off" },
      ],
    });
    if (projectMenu?.type !== "submenu") throw new Error("Expected project submenu");

    projectMenu.items[0]?.onPress();
    projectMenu.items[3]?.onPress();
    expect(onProjectScopeChange).toHaveBeenNthCalledWith(1, []);
    expect(onProjectScopeChange).toHaveBeenNthCalledWith(2, ["environment-1:project-2"]);
  });

  it("toggles additional projects after Select projects is turned on", () => {
    const onProjectScopeChange = vi.fn();
    const onProjectSelectModeChange = vi.fn();
    const menu = buildHomeListFilterMenu({
      environments: [],
      projects: [
        { key: "environment-1:project-1", label: "Codething" },
        { key: "environment-1:project-2", label: "Website" },
      ],
      selectedEnvironmentId: null,
      selectedProjectKeys: ["environment-1:project-1"],
      projectSelectMode: true,
      projectSortOrder: "updated_at",
      threadSortOrder: "updated_at",
      onEnvironmentChange: vi.fn(),
      onProjectScopeChange,
      onProjectSelectModeChange,
      onProjectSortOrderChange: vi.fn(),
      onThreadSortOrderChange: vi.fn(),
    });

    const projectMenu = menu.items.find(
      (item) => item.type === "submenu" && item.title === "Project",
    );
    if (projectMenu?.type !== "submenu") throw new Error("Expected project submenu");
    expect(projectMenu.items[1]).toMatchObject({ title: "Select projects", state: "on" });

    projectMenu.items[3]?.onPress();
    expect(onProjectScopeChange).toHaveBeenCalledWith([
      "environment-1:project-1",
      "environment-1:project-2",
    ]);
  });
});
