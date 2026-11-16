/** A GitHub label Dispatch creates and applies */
export interface LabelSpec {
  name: string;
  /** Hex colour without the leading # */
  color: string;
  description: string;
}

/**
 * Every Dispatch PR carries this label, so Dispatch's work stands out in the PR list
 * and can be filtered (`label:"⚡ dispatch"`). `dispatch init` creates it up front.
 */
export const DISPATCH_LABEL: LabelSpec = {
  name: "⚡ dispatch",
  color: "FBCA04",
  description: "Opened by Dispatch, the AI issue solver",
};

/** Colour and description for the labels Dispatch adds to issues it classifies */
export const CLASSIFICATION_LABEL_STYLE = {
  color: "7057ff",
  description: "Auto-classified by Dispatch",
};
