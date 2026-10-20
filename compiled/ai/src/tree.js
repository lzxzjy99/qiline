/** No negamax sign flipping: the same real player may act on consecutive commands. */
export function alphaBeta(node, depth, root, tree, alpha = -Infinity, beta = Infinity) {
    tree.check();
    if (depth === 0 || tree.terminal(node))
        return { value: tree.evaluate(node), variation: [] };
    const maximize = tree.player(node) === root;
    let value = maximize ? -Infinity : Infinity, variation = [], any = false;
    for (const child of tree.children(node)) {
        const result = alphaBeta(child.node, depth - 1, root, tree, alpha, beta);
        if (!any || (maximize ? result.value > value : result.value < value)) {
            value = result.value;
            variation = [child.move, ...result.variation];
        }
        any = true;
        if (maximize)
            alpha = Math.max(alpha, value);
        else
            beta = Math.min(beta, value);
        if (alpha >= beta) {
            tree.cutoff();
            break;
        }
    }
    return any ? { value, variation } : { value: tree.evaluate(node), variation: [] };
}
