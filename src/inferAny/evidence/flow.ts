// Statement termination analysis used to decide implicit `undefined` returns.
import * as ts from 'typescript';

export function statementsMayFallThrough(statements: readonly ts.Statement[]): boolean {
  for (const statement of statements) {
    if (statementAlwaysTerminates(statement)) {
      return false; // unreachable past this point
    }
  }
  return true;
}

export function statementAlwaysTerminates(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    return true;
  }
  if (ts.isBlock(statement)) {
    return statementsMayFallThrough(statement.statements) === false;
  }
  if (ts.isIfStatement(statement)) {
    // Terminates only if there is an else and BOTH branches terminate.
    return (
      statement.elseStatement !== undefined &&
      statementAlwaysTerminates(statement.thenStatement) &&
      statementAlwaysTerminates(statement.elseStatement)
    );
  }
  if (ts.isSwitchStatement(statement)) {
    // Terminates only with a default case and no fall-through out of any clause.
    const clauses = statement.caseBlock.clauses;
    if (!clauses.some((c) => ts.isDefaultClause(c))) {
      return false;
    }
    return clauses.every((clause) =>
      clause.statements.length > 0 && statementAlwaysTerminates(clause.statements[clause.statements.length - 1]!),
    );
  }
  if (ts.isTryStatement(statement)) {
    // Both try and every catch/finally path must terminate.
    const tryTerminates = statementsMayFallThrough(statement.tryBlock.statements) === false;
    const catchTerminates =
      statement.catchClause === undefined ||
      statementsMayFallThrough(statement.catchClause.block.statements) === false;
    const finallyTerminates =
      statement.finallyBlock === undefined ||
      statementsMayFallThrough(statement.finallyBlock.statements) === false;
    return tryTerminates && catchTerminates && finallyTerminates;
  }
  // Labeled statement wrapping a terminating statement.
  if (ts.isLabeledStatement(statement)) {
    return statementAlwaysTerminates(statement.statement);
  }
  return false;
}
